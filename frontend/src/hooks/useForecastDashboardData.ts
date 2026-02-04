import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ModelKey, SeriesResponse } from "../api/forecasts";
import { metricsApi, type DailyErrorPoint, type MetricsResponse } from "../api/metrics";
import { apiGet, apiPost, ApiError } from "../api/client";
import { runsApi } from "../api/runs";

function addDaysIsoUTC(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function errorToString(err: unknown) {
  if (!err) return "Unbekannter Fehler";
  if (typeof err === "string") return err;
  if (err instanceof ApiError) {
    const body = typeof err.body === "string" ? err.body : JSON.stringify(err.body);
    return `API ${err.status}: ${body}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function clip0(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

function isoWeekKey(isoDate: string): string {
  const d = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

type LegacyActualPoint = { date: string; actual?: number; value?: number };
type LegacyForecastResponse = {
  forecast: Array<{ date: string; forecast: number; p05?: number | null; p95?: number | null }>;
};

async function loadSeriesLive(modelKey: string, startDate: string, horizonDays: number, historyDays: number) {
  const endDate = addDaysIsoUTC(startDate, Math.max(1, horizonDays) - 1);
  return apiPost<SeriesResponse>(`/series/${encodeURIComponent(modelKey)}`, {
    start_date: startDate,
    end_date: endDate,
    history_days: historyDays,
    include_quantiles: true,
  });
}

async function loadSeriesLegacy(modelKey: string, startDate: string, horizonDays: number, historyDays: number) {
  const [actualsRes, forecastRes] = await Promise.allSettled([
    apiGet<LegacyActualPoint[]>(`/actuals/${encodeURIComponent(modelKey)}`),
    apiPost<LegacyForecastResponse>(`/forecast/${encodeURIComponent(modelKey)}`, {
      start_date: startDate,
      horizon_days: horizonDays,
    }),
  ]);

  const actualsRaw = actualsRes.status === "fulfilled" ? actualsRes.value : [];
  const forecastRaw = forecastRes.status === "fulfilled" ? forecastRes.value : { forecast: [] };

  if (actualsRes.status !== "fulfilled" && forecastRes.status !== "fulfilled") {
    throw new Error(
      `Legacy fallback failed. actuals=${errorToString(actualsRes.reason)} forecast=${errorToString(forecastRes.reason)}`
    );
  }

  const startTs = new Date(`${startDate}T00:00:00Z`).getTime();
  const normalizedActuals = (Array.isArray(actualsRaw) ? actualsRaw : [])
    .map((p) => ({
      date: String(p?.date ?? "").slice(0, 10),
      actual: Number(p?.actual ?? p?.value),
    }))
    .filter((p) => p.date && Number.isFinite(p.actual))
    .filter((p) => new Date(`${p.date}T00:00:00Z`).getTime() < startTs);
  const actuals = normalizedActuals.slice(Math.max(0, normalizedActuals.length - Math.max(0, historyDays)));

  return {
    actuals,
    forecast: Array.isArray(forecastRaw?.forecast) ? forecastRaw.forecast : [],
    meta: {
      dataset: modelKey,
      mode: "legacy",
      actuals_from: actuals.length ? actuals[0].date : undefined,
      actuals_to: actuals.length ? actuals[actuals.length - 1].date : undefined,
      forecast_from: startDate,
      forecast_to: addDaysIsoUTC(startDate, Math.max(1, horizonDays) - 1),
    },
  } as SeriesResponse;
}

export type WeeklyPoint = {
  week: string;
  iso: string;
  actual: number | null;
  forecast: number | null;
  p05: number | null;
  p95: number | null;
  opportunities?: number | null;
  revenue?: number | null;
};

export type StaffingRow = {
  week: string;
  forecastKg: number;
  fteNeeded: number;
  utilizationPct: number;
  baseFte: number;
  savingsCHF: number;
};

type LoadingState = { series: boolean; kpis: boolean; dailyErrors: boolean; outliers: boolean };
type ErrorState = { series?: string; kpis?: string; dailyErrors?: string; outliers?: string };

function parseSeriesToWeeklyPoints(payload: SeriesResponse): WeeklyPoint[] {
  const actualsArr: any[] = Array.isArray((payload as any)?.actuals) ? (payload as any).actuals : [];
  const forecastArr: any[] = Array.isArray((payload as any)?.forecast) ? (payload as any).forecast : [];
  if (actualsArr.length === 0 && forecastArr.length === 0) return [];

  type Daily = {
    iso: string;
    week: string;
    actual: number | null;
    forecast: number | null;
    p05: number | null;
    p95: number | null;
  };
  const daily: Daily[] = [];

  for (const a of actualsArr) {
    const iso = String(a?.date ?? "").slice(0, 10);
    if (!iso) continue;
    const v = a?.value ?? a?.actual;
    daily.push({
      iso,
      week: isoWeekKey(iso),
      actual: v == null ? null : clip0(Number(v)),
      forecast: null,
      p05: null,
      p95: null,
    });
  }

  for (const f of forecastArr) {
    const iso = String(f?.date ?? "").slice(0, 10);
    if (!iso) continue;
    const y = f?.forecast == null ? null : clip0(Number(f.forecast));
    const p05Raw = f?.p05 == null ? null : clip0(Number(f.p05));
    const p95Raw = f?.p95 == null ? null : clip0(Number(f.p95));

    let p05 = p05Raw;
    let p95 = p95Raw;
    if (y != null && Number.isFinite(y)) {
      // keep visual bands stable even if backend quantile models are noisy
      const bandBase = Math.max(1000, y, 1);
      if (p05 != null) p05 = Math.min(Math.max(0, p05), y);
      if (p95 != null) p95 = Math.max(y, Math.min(p95, bandBase * 3.0));
      if (p05 != null && p95 != null && p05 > p95) p05 = Math.min(y, p95);
    }

    daily.push({
      iso,
      week: isoWeekKey(iso),
      actual: null,
      forecast: y,
      p05,
      p95,
    });
  }

  const byWeek = new Map<
    string,
    {
      firstIso: string;
      actualSum: number;
      actualCount: number;
      forecastSum: number;
      forecastCount: number;
      p05Sum: number;
      p05Count: number;
      p95Sum: number;
      p95Count: number;
    }
  >();

  for (const d of daily) {
    const cur = byWeek.get(d.week) ?? {
      firstIso: d.iso,
      actualSum: 0,
      actualCount: 0,
      forecastSum: 0,
      forecastCount: 0,
      p05Sum: 0,
      p05Count: 0,
      p95Sum: 0,
      p95Count: 0,
    };
    if (d.iso < cur.firstIso) cur.firstIso = d.iso;
    if (d.actual != null) {
      cur.actualSum += d.actual;
      cur.actualCount += 1;
    }
    if (d.forecast != null) {
      cur.forecastSum += d.forecast;
      cur.forecastCount += 1;
    }
    if (d.p05 != null) {
      cur.p05Sum += d.p05;
      cur.p05Count += 1;
    }
    if (d.p95 != null) {
      cur.p95Sum += d.p95;
      cur.p95Count += 1;
    }
    byWeek.set(d.week, cur);
  }

  return Array.from(byWeek.entries())
    .map(([week, v]) => {
      const forecast = v.forecastCount ? v.forecastSum : null;
      const actual = v.actualCount ? v.actualSum : null;
      const opportunitiesBase = forecast != null ? forecast : (actual ?? null);
      const opportunities = opportunitiesBase != null ? Math.max(0, opportunitiesBase * 0.05) : null;
      return {
        week,
        iso: v.firstIso,
        actual,
        forecast,
        p05: v.p05Count ? v.p05Sum : null,
        p95: v.p95Count ? v.p95Sum : null,
        opportunities,
      };
    })
    .sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0));
}

function makeStaffingTable(weekly: WeeklyPoint[]): StaffingRow[] {
  const KG_PER_FTE_WEEK = 6500;
  const BASE_FTE = 10;
  const CHF_PER_FTE_WEEK = 2500;

  return weekly.map((w) => {
    const y = w.forecast ?? 0;
    const fteNeeded = y > 0 ? y / KG_PER_FTE_WEEK : 0;
    const baseFte = BASE_FTE;
    const utilizationPct = baseFte > 0 ? clamp((fteNeeded / baseFte) * 100, 0, 250) : 0;
    const unused = Math.max(0, baseFte - fteNeeded);
    return {
      week: w.week,
      forecastKg: y,
      fteNeeded,
      utilizationPct,
      baseFte,
      savingsCHF: unused * CHF_PER_FTE_WEEK,
    };
  });
}

export function useForecastDashboardData({
  runId,
  modelKey,
  startDate,
  horizonDays,
  historyDays,
  backtestDays,
  dailyErrorLimit,
  outlierLimit,
}: {
  runId?: string | null;
  modelKey: ModelKey;
  startDate: string;
  horizonDays: number;
  historyDays: number;
  backtestDays: number;
  dailyErrorLimit: number;
  outlierLimit: number;
}) {
  const isRunMode = !!runId;

  const [payload, setPayload] = useState<SeriesResponse | null>(null);
  const [weekly, setWeekly] = useState<WeeklyPoint[]>([]);
  const [hasQuantiles, setHasQuantiles] = useState(false);

  const [kpiMetrics, setKpiMetrics] = useState<MetricsResponse | null>(null);
  const [chartDailyErrors, setChartDailyErrors] = useState<DailyErrorPoint[]>([]);
  const [outlierDailyErrors, setOutlierDailyErrors] = useState<DailyErrorPoint[]>([]);

  const [loading, setLoading] = useState<LoadingState>({ series: false, kpis: false, dailyErrors: false, outliers: false });
  const [errors, setErrors] = useState<ErrorState>({});
  const requestIdRef = useRef(0);

  const staffing = useMemo(() => makeStaffingTable(weekly), [weekly]);
  const savingsTotal = useMemo(() => staffing.reduce((acc, row) => acc + row.savingsCHF, 0), [staffing]);

  const outliers = useMemo(() => {
    return [...(outlierDailyErrors ?? [])]
      .sort((a, b) => {
        const scoreA = a.ape != null ? Number(a.ape) : Number(a.abs_error ?? 0);
        const scoreB = b.ape != null ? Number(b.ape) : Number(b.abs_error ?? 0);
        if (scoreB !== scoreA) return scoreB - scoreA;
        if (b.abs_error !== a.abs_error) return b.abs_error - a.abs_error;
        return String(a.date).localeCompare(String(b.date));
      })
      .slice(0, 10);
  }, [outlierDailyErrors]);

  const datasetLabel = useMemo(() => {
    const meta = (payload as any)?.meta ?? {};
    return (meta?.dataset as string | undefined) ?? (meta?.mode as string | undefined) ?? String(modelKey);
  }, [payload, modelKey]);

  const rangeLabel = useMemo(() => {
    const m = (payload as any)?.meta ?? {};
    if (m?.forecast_from && m?.forecast_to) return `Forecast: ${String(m.forecast_from)} → ${String(m.forecast_to)}`;
    return "";
  }, [payload]);

  const loadAll = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const isStale = () => requestId !== requestIdRef.current;
    const applyMetricResult = (
      result: PromiseSettledResult<MetricsResponse>,
      key: "kpis" | "dailyErrors" | "outliers",
      onSuccess: (data: MetricsResponse) => void,
      onFailure: () => void
    ) => {
      if (result.status === "fulfilled") {
        onSuccess(result.value);
        setErrors((prev) => ({ ...prev, [key]: undefined }));
      } else {
        onFailure();
        setErrors((prev) => ({ ...prev, [key]: errorToString(result.reason) }));
      }
    };

    setErrors({});
    setLoading({ series: true, kpis: false, dailyErrors: false, outliers: false });
    setKpiMetrics(null);
    setChartDailyErrors([]);
    setOutlierDailyErrors([]);

    let seriesOk = false;
    try {
      let res: SeriesResponse;

      if (runId) {
        try {
          res = (await runsApi.getSeries(runId)) as unknown as SeriesResponse;
        } catch {
          res = await loadSeriesLive(String(modelKey), startDate, horizonDays, historyDays);
        }
      } else {
        try {
          res = await loadSeriesLive(String(modelKey), startDate, horizonDays, historyDays);
        } catch {
          res = await loadSeriesLegacy(String(modelKey), startDate, horizonDays, historyDays);
        }
      }

      setPayload(res);
      setErrors((prev) => ({ ...prev, series: undefined }));
      seriesOk = true;
    } catch (err) {
      setPayload(null);
      setErrors((prev) => ({ ...prev, series: errorToString(err) }));
    } finally {
      setLoading((prev) => ({ ...prev, series: false }));
    }

    if (isStale()) return;

    if (!seriesOk) {
      setLoading((prev) => ({ ...prev, kpis: false, dailyErrors: false, outliers: false }));
      return;
    }

    setLoading((prev) => ({ ...prev, kpis: true, dailyErrors: true, outliers: true }));

    const dailyLimit = Math.max(1, dailyErrorLimit);
    const outlierTop = Math.max(1, outlierLimit);

    if (runId) {
      const [kpiRes, dailyRes, outlierRes] = await Promise.allSettled([
        metricsApi.getRunMetrics(runId, { backtestDays, includeDailyErrors: false }),
        metricsApi.getRunMetrics(runId, {
          backtestDays,
          includeDailyErrors: true,
          dailyErrorsLimit: dailyLimit,
          outliersOnly: false,
        }),
        metricsApi.getRunMetrics(runId, {
          backtestDays,
          includeDailyErrors: true,
          dailyErrorsLimit: outlierTop,
          outliersOnly: true,
        }),
      ]);

      if (isStale()) return;
      applyMetricResult(kpiRes, "kpis", (x) => setKpiMetrics(x), () => setKpiMetrics(null));
      applyMetricResult(dailyRes, "dailyErrors", (x) => setChartDailyErrors(x.daily_errors ?? []), () => setChartDailyErrors([]));
      applyMetricResult(outlierRes, "outliers", (x) => setOutlierDailyErrors(x.daily_errors ?? []), () => setOutlierDailyErrors([]));
    } else {
      const req = {
        start_date: startDate,
        history_days: Math.max(1, historyDays),
        backtest_days: Math.max(7, backtestDays),
      };

      const [kpiRes, dailyRes, outlierRes] = await Promise.allSettled([
        metricsApi.getLiveMetrics(String(modelKey), req, {
          includeDailyErrors: false,
          backtestDays,
        }),
        metricsApi.getLiveMetrics(String(modelKey), req, {
          includeDailyErrors: true,
          dailyErrorsLimit: dailyLimit,
          outliersOnly: false,
          backtestDays,
        }),
        metricsApi.getLiveMetrics(String(modelKey), req, {
          includeDailyErrors: true,
          dailyErrorsLimit: outlierTop,
          outliersOnly: true,
          backtestDays,
        }),
      ]);

      if (isStale()) return;
      applyMetricResult(kpiRes, "kpis", (x) => setKpiMetrics(x), () => setKpiMetrics(null));
      applyMetricResult(dailyRes, "dailyErrors", (x) => setChartDailyErrors(x.daily_errors ?? []), () => setChartDailyErrors([]));
      applyMetricResult(outlierRes, "outliers", (x) => setOutlierDailyErrors(x.daily_errors ?? []), () => setOutlierDailyErrors([]));
    }

    if (isStale()) return;
    setLoading((prev) => ({ ...prev, kpis: false, dailyErrors: false, outliers: false }));
  }, [runId, modelKey, startDate, horizonDays, historyDays, backtestDays, dailyErrorLimit, outlierLimit]);

  useEffect(() => {
    if (!payload) {
      setWeekly([]);
      setHasQuantiles(false);
      return;
    }
    const next = parseSeriesToWeeklyPoints(payload);
    setWeekly(next);
    setHasQuantiles(next.some((p) => p.p05 != null && p.p95 != null));
  }, [payload]);

  return {
    isRunMode,
    payload,
    weekly,
    hasQuantiles,
    kpiMetrics,
    chartDailyErrors,
    outlierDailyErrors,
    staffing,
    outliers,
    savingsTotal,
    datasetLabel,
    rangeLabel,
    loading,
    errors,
    loadAll,
  };
}
