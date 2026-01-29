// src/hooks/useForecastDashboardData.ts
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ModelKey, SeriesResponse } from "../api/forecasts";
import type { MetricsResponse, DailyErrorPoint } from "../api/metrics";
import { ApiError } from "../api/client";

/* =========================
   helpers
========================= */

function addDaysIsoUTC(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* =========================
   data loader
========================= */

async function loadAll() {
  try {
    setLoading(true);
    setError(null);

    if (runId) {
      // RUN MODE (historischer Lauf)
      const res = await runsApi.getSeries(runId);
      setPayload(res as any);
    } else {
  const endDate = addDaysIsoUTC(startDate, Math.max(1, horizonDays) - 1);
  const datasetKey = String(modelKey);

  const res = await fetchJson<SeriesResponse>(
    `/api/series/${encodeURIComponent(datasetKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start_date: startDate,
        end_date: endDate,
        history_days: historyDays,
        include_quantiles: true,
      }),
    }
  );

  setPayload(res as any);
}

  } catch (e: any) {
    setError(e?.message ?? String(e));
  } finally {
    setLoading(false);
  }
}

function errorToString(err: unknown) {
  if (!err) return "Unbekannter Fehler";
  if (typeof err === "string") return err;
  if (err instanceof ApiError) {
    const body = typeof (err as any).body === "string" ? (err as any).body : JSON.stringify((err as any).body);
    return `API ${(err as any).status}: ${body}`;
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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      try {
        body = await res.text();
      } catch {
        body = null;
      }
    }
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

type LegacyActualPoint = { date: string; actual?: number; value?: number };

async function fetchLegacyActuals(modelKey: string): Promise<Array<{ date: string; value: number }>> {
  const arr = await fetchJson<LegacyActualPoint[]>(`/api/actuals/${encodeURIComponent(modelKey)}`);
  return (Array.isArray(arr) ? arr : [])
    .map((p) => ({
      date: String((p as any)?.date ?? "").slice(0, 10),
      value: Number((p as any)?.value ?? (p as any)?.actual),
    }))
    .filter((p) => p.date && Number.isFinite(p.value));
}

type ForecastApiResponse = {
  model?: string;
  start_date?: string;
  horizon_days?: number;
  forecast: Array<{ date: string; forecast: number; p05?: number | null; p95?: number | null }>;
};

async function fetchForecast(modelKey: string, startDate: string, horizonDays: number): Promise<ForecastApiResponse> {
  return await fetchJson<ForecastApiResponse>(`/api/forecast/${encodeURIComponent(modelKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start_date: startDate, horizon_days: horizonDays }),
  });
}

function sliceHistory(actuals: Array<{ date: string; value: number }>, startDate: string, historyDays: number) {
  const startTs = new Date(`${startDate}T00:00:00Z`).getTime();
  const filtered = actuals.filter((p) => new Date(`${p.date}T00:00:00Z`).getTime() < startTs);
  return filtered.slice(Math.max(0, filtered.length - Math.max(0, historyDays)));
}

/* ----------------------------- types ----------------------------- */

export type WeeklyPoint = {
  week: string; // ISO week key (YYYY-Www)
  iso: string; // first date in that week (ISO, YYYY-MM-DD)
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

function clip0(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

// ISO week key helper (YYYY-Www) stable across year boundaries
function isoWeekKey(isoDate: string): string {
  const d = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const yyyy = d.getUTCFullYear();
  const ww = String(weekNo).padStart(2, "0");
  return `${yyyy}-W${ww}`;
}

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
    const iso = a?.date ?? null;
    if (!iso) continue;
    const v = a?.value ?? a?.actual ?? null;
    daily.push({
      iso: String(iso).slice(0, 10),
      week: isoWeekKey(String(iso)),
      actual: v == null ? null : clip0(Number(v)),
      forecast: null,
      p05: null,
      p95: null,
    });
  }

  for (const f of forecastArr) {
    const iso = f?.date ?? null;
    if (!iso) continue;
    const y = f?.forecast ?? null;
    const p05 = f?.p05 ?? null;
    const p95 = f?.p95 ?? null;

    daily.push({
      iso: String(iso).slice(0, 10),
      week: isoWeekKey(String(iso)),
      actual: null,
      forecast: y == null ? null : clip0(Number(y)),
      p05: p05 == null ? null : clip0(Number(p05)),
      p95: p95 == null ? null : clip0(Number(p95)),
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
    const k = d.week;
    const cur = byWeek.get(k) ?? {
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

    byWeek.set(k, cur);
  }

  return Array.from(byWeek.entries())
    .map(([week, v]) => ({
      week,
      iso: v.firstIso,
      actual: v.actualCount ? v.actualSum : null,
      forecast: v.forecastCount ? v.forecastSum : null,
      p05: v.p05Count ? v.p05Sum : null,
      p95: v.p95Count ? v.p95Sum : null,
    }))
    .sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0));
}

function makeStaffingTable(weekly: WeeklyPoint[]): StaffingRow[] {
  const KG_PER_FTE_WEEK = 6500;
  const BASE_FTE = 10;
  const CHF_PER_FTE_WEEK = 2500;

  return (weekly ?? []).map((w) => {
    const y = w.forecast ?? 0;
    const fteNeeded = y > 0 ? y / KG_PER_FTE_WEEK : 0;
    const baseFte = BASE_FTE;
    const utilizationPct = baseFte > 0 ? clamp((fteNeeded / baseFte) * 100, 0, 250) : 0;

    const unused = Math.max(0, baseFte - fteNeeded);
    const savingsCHF = unused * CHF_PER_FTE_WEEK;

    return { week: w.week, forecastKg: y, fteNeeded, utilizationPct, baseFte, savingsCHF };
  });
}

/* ----------------------------- hook ----------------------------- */

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

  // kept for UI compatibility but not loaded from API anymore
  const [kpiMetrics, setKpiMetrics] = useState<MetricsResponse | null>(null);
  const [chartDailyErrors, setChartDailyErrors] = useState<DailyErrorPoint[]>([]);
  const [outlierDailyErrors, setOutlierDailyErrors] = useState<DailyErrorPoint[]>([]);

  const [loading, setLoading] = useState({ series: false, kpis: false, dailyErrors: false, outliers: false });
  const [errors, setErrors] = useState<{ series?: string; kpis?: string; dailyErrors?: string; outliers?: string }>({});

  const staffing = useMemo(() => makeStaffingTable(weekly), [weekly]);
  const savingsTotal = useMemo(() => staffing.reduce((a, r) => a + r.savingsCHF, 0), [staffing]);

  const outliers = useMemo(() => {
    const xs: DailyErrorPoint[] = (outlierDailyErrors ?? []) as any;
    return xs
      .map((d) => ({ ...d, score: (d as any).ape != null ? (d as any).ape : (d as any).abs_error ?? 0 }))
      .sort((a, b) => ((b as any).score ?? 0) - ((a as any).score ?? 0))
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
    setErrors({});
    setLoading({ series: true, kpis: false, dailyErrors: false, outliers: false });

    // reset optional layers
    setKpiMetrics(null);
    setChartDailyErrors([]);
    setOutlierDailyErrors([]);

    try {
      if (runId) {
        const res = await runsApi.getSeries(runId);
        setPayload(res as any);
      } else {
        const [actualsAll, fc] = await Promise.all([
          fetchLegacyActuals(String(modelKey)),
          fetchForecast(String(modelKey), startDate, horizonDays),
        ]);

        const actuals = sliceHistory(actualsAll, startDate, historyDays);

        const merged: SeriesResponse = {
          actuals,
          forecast: Array.isArray(fc?.forecast) ? fc.forecast : [],
          meta: {
            dataset: String(modelKey),
            mode: "live",
            actuals_from: actuals.length ? actuals[0].date : undefined,
            actuals_to: actuals.length ? actuals[actuals.length - 1].date : undefined,
            forecast_from: startDate,
            forecast_to: addDaysIsoUTC(startDate, Math.max(1, horizonDays) - 1),
          } as any,
        } as any;

        setPayload(merged);
      }
      setErrors((e) => ({ ...e, series: undefined }));
    } catch (err) {
      setPayload(null);
      setErrors((e) => ({ ...e, series: errorToString(err) }));
    } finally {
      setLoading((s) => ({ ...s, series: false }));
    }

    // These endpoints do not exist in your backend → keep as “not available”
    setKpiMetrics(null);
    setChartDailyErrors([]);
    setOutlierDailyErrors([]);
    setErrors((e) => ({ ...e, kpis: undefined, dailyErrors: undefined, outliers: undefined }));
    setLoading((s) => ({ ...s, kpis: false, dailyErrors: false, outliers: false }));

    void backtestDays;
    void dailyErrorLimit;
    void outlierLimit;
  }, [runId, modelKey, startDate, horizonDays, historyDays, backtestDays, dailyErrorLimit, outlierLimit]);

  useEffect(() => {
    if (!payload) {
      setWeekly([]);
      setHasQuantiles(false);
      return;
    }
    const w = parseSeriesToWeeklyPoints(payload);
    setWeekly(w);
    setHasQuantiles(w.some((p) => p.p05 != null && p.p95 != null));
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
