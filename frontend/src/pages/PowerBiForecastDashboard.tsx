import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from "recharts";
import type { TooltipProps } from "recharts";

import type { ModelKey } from "../api/forecasts";
import type { DailyErrorPoint } from "../api/metrics";
import { ApiError } from "../api/client";

import { useForecastDashboardData, type WeeklyPoint } from "../hooks/useForecastDashboardData";

/** ---------- Formatting ---------- */
function formatKg(n: number) {
  return `${Math.round(n).toLocaleString("de-CH")} kg`;
}
function formatMoney(n: number) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}CHF ${(abs / 1_000_000_000).toFixed(2)} Mrd`;
  if (abs >= 1_000_000) return `${sign}CHF ${(abs / 1_000_000).toFixed(1)} Mio`;
  return `${sign}CHF ${Math.round(abs).toLocaleString("de-CH")}`;
}
function formatPct2(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
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

function isoWeekKey(isoDate: string): string {
  const d = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** ---------- Dataset list (NEW, minimal) ---------- */
type DatasetKey = "export" | "import" | "tra_export" | "tra_import";
type DatasetMeta = { key: string; data_from?: string; data_to?: string; points?: number };
type DatasetsResponse = { available?: DatasetMeta[] };

const DATASET_LABELS: Record<DatasetKey, string> = {
  export: "Export (abgehend)",
  import: "Import (eingehend)",
  tra_export: "Transit Export",
  tra_import: "Transit Import",
};

function formatDatasetLabel(k: string): string {
  if ((k as DatasetKey) in DATASET_LABELS) return DATASET_LABELS[k as DatasetKey];
  return k;
}

function formatMethodLabel(method?: string | null): string {
  if (!method) return "—";
  if (method === "xgb_walk_forward_1d") return "XGBoost Walk-Forward";
  if (method === "xgb_recursive") return "XGBoost Rekursiv";
  if (method === "naive_persistence_fallback") return "Fallback (Persistenz)";
  return method;
}

async function fetchDatasets(): Promise<DatasetKey[]> {
  const res = await fetch("/api/datasets");
  if (!res.ok) throw new Error(`GET /api/datasets failed (${res.status})`);
  const json = (await res.json()) as DatasetsResponse | DatasetMeta[];
  const list = Array.isArray(json) ? json : (json.available ?? []);
  const keys = list
    .map((d) => d.key)
    .filter(Boolean) as string[];

  // Keep only our supported keys (prevents weird data)
  const allowed: DatasetKey[] = ["export", "import", "tra_export", "tra_import"];
  const filtered = keys.filter((k) => allowed.includes(k as DatasetKey)) as DatasetKey[];
  const order: DatasetKey[] = ["export", "import", "tra_export", "tra_import"];
  const sorted = (filtered.length ? filtered : allowed).sort((a, b) => order.indexOf(a) - order.indexOf(b));

  return sorted;
}

/** ---------- Staffing model (unverändert) ---------- */
type ShiftPlan = { label: string; share: number; minFTE: number };

type StaffingRow = {
  week: string;
  sumWeight: number;
  requiredFTE: number;
  targetFTE: number;
  utilizationPct: number;
  deltaFTE: number;
  reqNight: number;
  reqDay: number;
  reqEve: number;
  planCostCHF: number;
  savingsCHF: number;
};

const EFF = {
  hoursPerFteWeek: 40,
  kgPerFteWeek: 72_000,
  costPerHourCHF: 42,
  targetUtilizationPct: 95,
  minBaseFte: 0,
};

const SHIFTS: ShiftPlan[] = [
  { label: "Nacht (00–08)", share: 0.22, minFTE: 2.0 },
  { label: "Tag (08–16)", share: 0.5, minFTE: 4.0 },
  { label: "Abend (16–24)", share: 0.28, minFTE: 3.0 },
];

function allocateToShifts(totalRequiredFTE: number) {
  const base = SHIFTS.map((s) => ({ minFTE: s.minFTE, raw: totalRequiredFTE * s.share }));
  let alloc = base.map((b) => Math.max(b.minFTE, b.raw));
  const sumAlloc = alloc.reduce((a, b) => a + b, 0);

  if (sumAlloc > 0 && sumAlloc !== totalRequiredFTE) {
    const scale = totalRequiredFTE / sumAlloc;
    alloc = alloc.map((x) => x * scale);
  }

  return {
    night: alloc[0] ?? 0,
    day: alloc[1] ?? 0,
    eve: alloc[2] ?? 0,
  };
}

function makeStaffingTable(weekly: WeeklyPoint[]): StaffingRow[] {
  return weekly.map((w) => {
    const sumWeight = w.forecast ?? 0;

    const requiredFTE = Math.max(EFF.minBaseFte, sumWeight / EFF.kgPerFteWeek);
    const targetFTE = requiredFTE / (EFF.targetUtilizationPct / 100);
    const utilizationPct = targetFTE > 0 ? (requiredFTE / targetFTE) * 100 : 0;

    const deltaFTE = targetFTE - requiredFTE;
    const shifts = allocateToShifts(targetFTE);

    const hours = targetFTE * EFF.hoursPerFteWeek;
    const planCostCHF = hours * EFF.costPerHourCHF;
    const savingsCHF = Math.max(0, deltaFTE) * EFF.hoursPerFteWeek * EFF.costPerHourCHF;

    return {
      week: w.week,
      sumWeight,
      requiredFTE,
      targetFTE,
      utilizationPct,
      deltaFTE,
      reqNight: shifts.night,
      reqDay: shifts.day,
      reqEve: shifts.eve,
      planCostCHF,
      savingsCHF,
    };
  });
}

function KpiTile({ title, value, subtitle }: { title: string; value: string; subtitle?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{title}</div>
      <div className="kpi-value">{value}</div>
      {subtitle ? <div className="kpi-note">{subtitle}</div> : null}
    </div>
  );
}

/** ---------- Insights / narrative layer ---------- */
type InsightCard = {
  title: string;
  status: "good" | "warn" | "bad";
  bullets: string[];
  footnote?: string;
};

function statusBadge(status: InsightCard["status"]) {
  if (status === "good") return "badge badge-success";
  if (status === "warn") return "badge badge-warning";
  return "badge badge-danger";
}

/** ---------- PowerBI-like Tooltip + Header Legend ---------- */
function pbLabel(label: any) {
  if (label == null) return "";
  return String(label);
}

function pbValueFormatter(name: string, value: any) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const v = Number(value);

  if (name.toLowerCase().includes("ape")) return `${(v * 100).toFixed(2)}%`;
  if (name.toLowerCase().includes("wape") || name.toLowerCase().includes("mape") || name.toLowerCase().includes("bias"))
    return `${v.toFixed(2)}%`;

  if (["forecast", "actual", "p05", "p95", "abs_error", "error"].includes(name)) return formatKg(v);

  if (name.toLowerCase().includes("opportun")) return formatMoney(v);

  return Math.round(v).toLocaleString("de-CH");
}

function pbSeriesName(raw: string) {
  switch (raw) {
    case "forecast":
      return "Forecast";
    case "actual":
      return "Actuals";
    case "p95":
      return "p95";
    case "p05":
      return "p05";
    case "opportunities":
      return "Savings Opportunity (Proxy)";
    case "abs_error":
      return "Abs Error";
    case "error":
      return "Abweichung";
    case "ape":
      return "APE";
    default:
      return raw;
  }
}

function HeaderLegend({
  items,
}: {
  items: Array<{ label: string; color: string; kind?: "line" | "dash" | "fill" }>;
}) {
  return (
    <div className="pbHeaderLegend">
      {items.map((it) => (
        <span key={it.label} className="pbHeaderLegendItem">
          <span
            className="pbHeaderLegendSwatch"
            style={{
              background: it.color,
              borderColor: "rgba(15,23,42,0.14)",
              outline: it.kind === "dash" ? "2px dashed rgba(15,23,42,0.35)" : "none",
              outlineOffset: it.kind === "dash" ? 2 : 0,
            }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function PbTooltip({ active, payload, label }: TooltipProps<any, any>) {
  if (!active || !payload?.length) return null;

  const rows = payload
    .filter((p) => p && p.value != null && p.name)
    .map((p) => ({
      name: pbSeriesName(String(p.name)),
      rawName: String(p.name),
      value: p.value,
      color: p.color ?? "rgba(15,23,42,.35)",
    }));

  const order = ["Forecast", "Actuals", "p95", "p05", "Savings Opportunity (Proxy)", "Abs Error", "APE"];
  rows.sort((a, b) => {
    const ai = order.indexOf(a.name);
    const bi = order.indexOf(b.name);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  if (!rows.length) return null;

  return (
    <div className="pbTooltip">
      <div className="pbTooltipTitle">{pbLabel(label)}</div>
      {rows.map((r) => (
        <div key={r.name} className="pbTooltipRow">
          <span className="pbTooltipDot" style={{ background: r.color }} />
          <span>{r.name}</span>
          <span className="pbTooltipValue">{pbValueFormatter(r.rawName, r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** ---------- Debug helpers ---------- */
function finiteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function minMax(values: Array<number | null | undefined>) {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (!xs.length) return { min: null as number | null, max: null as number | null };
  let min = xs[0]!;
  let max = xs[0]!;
  for (const v of xs) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

export default function PowerBiForecastDashboard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const runId = searchParams.get("runId") ?? searchParams.get("run_id");

  /** NEW: dataset keys from backend */
  const [availableKeys, setAvailableKeys] = useState<DatasetKey[]>(["export", "import", "tra_export", "tra_import"]);
  const [datasetLoadError, setDatasetLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchDatasets()
      .then((keys) => {
        setAvailableKeys(keys);
        setDatasetLoadError(null);
      })
      .catch((e) => {
        // fallback stays active
        setDatasetLoadError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  // modelKey is typed as ModelKey in existing codebase; we keep it, but allow extra keys via DatasetKey.
  const [modelKey, setModelKey] = useState<DatasetKey>("export");
  const [startDate, setStartDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [horizonDays, setHorizonDays] = useState<number>(28);
  const [historyDays, setHistoryDays] = useState<number>(90);
  const [granularity, setGranularity] = useState<"weekly" | "daily">("weekly");

  const backtestDays = 56;

  const {
    isRunMode,
    payload,
    weekly,
    hasQuantiles,
    kpiMetrics,
    chartDailyErrors,
    outlierDailyErrors,
    loading,
    errors,
    datasetLabel,
    rangeLabel,
    loadAll,
  } = useForecastDashboardData({
    runId,
    // Cast keeps the hook unchanged; backend already supports tra_* keys.
    modelKey: modelKey as unknown as ModelKey,
    startDate,
    horizonDays,
    historyDays,
    backtestDays,
    dailyErrorLimit: 120,
    outlierLimit: 20,
  });

  const debugFromUrl = searchParams.get("debug") === "1";
  const [showDebug, setShowDebug] = useState<boolean>(debugFromUrl);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const staffing = useMemo(() => makeStaffingTable(weekly), [weekly]);
  const savingsTotal = useMemo(() => staffing.reduce((a, r) => a + r.savingsCHF, 0), [staffing]);
  const operationsData = useMemo(() => {
    const byWeek = new Map(staffing.map((row) => [row.week, row]));
    return weekly.map((w) => {
      const s = byWeek.get(w.week);
      return {
        ...w,
        planCostCHF: s?.planCostCHF ?? null,
        opportunities: w.opportunities ?? 0,
      };
    });
  }, [weekly, staffing]);

  const dailyTrend = useMemo(() => {
    const actuals = Array.isArray((payload as any)?.actuals) ? (payload as any).actuals : [];
    const forecast = Array.isArray((payload as any)?.forecast) ? (payload as any).forecast : [];
    const byDate = new Map<
      string,
      { date: string; week: string; actual: number | null; forecast: number | null; p05: number | null; p95: number | null }
    >();

    for (const a of actuals) {
      const iso = String(a?.date ?? "").slice(0, 10);
      const v = Number(a?.value ?? a?.actual);
      if (!iso || !Number.isFinite(v)) continue;
      const cur = byDate.get(iso) ?? { date: iso, week: isoWeekKey(iso), actual: null, forecast: null, p05: null, p95: null };
      cur.actual = Math.max(0, v);
      byDate.set(iso, cur);
    }

    for (const f of forecast) {
      const iso = String(f?.date ?? "").slice(0, 10);
      const y = Number(f?.forecast);
      if (!iso || !Number.isFinite(y)) continue;
      const cur = byDate.get(iso) ?? { date: iso, week: isoWeekKey(iso), actual: null, forecast: null, p05: null, p95: null };
      cur.forecast = Math.max(0, y);
      const p05 = Number(f?.p05);
      const p95 = Number(f?.p95);
      if (Number.isFinite(p05)) cur.p05 = Math.max(0, Math.min(p05, cur.forecast ?? p05));
      if (Number.isFinite(p95)) cur.p95 = Math.max(cur.forecast ?? 0, p95);
      byDate.set(iso, cur);
    }

    return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }, [payload]);

  const trendData = granularity === "daily" ? dailyTrend : weekly;
  const trendXAxisKey = granularity === "daily" ? "date" : "week";
  const forecastStartLabel = useMemo(() => {
    if (granularity === "daily") return dailyTrend.find((d) => d.forecast != null)?.date ?? null;
    return weekly.find((w) => w.forecast != null)?.week ?? null;
  }, [granularity, dailyTrend, weekly]);

  const outliers = useMemo(() => {
    const xs = outlierDailyErrors ?? [];
    const scored = xs
      .map((d: any) => ({
        ...d,
        score: d.ape != null ? d.ape : d.abs_error ?? 0,
      }))
      .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0));
    return scored.slice(0, 10);
  }, [outlierDailyErrors]);

  const forecastTotal = useMemo(() => weekly.reduce((acc, w) => acc + (w.forecast ?? 0), 0), [weekly]);
  const actualsTotal = useMemo(() => weekly.reduce((acc, w) => acc + (w.actual ?? 0), 0), [weekly]);
  const datasetDisplayLabel = useMemo(() => {
    if (datasetLabel) return formatDatasetLabel(String(datasetLabel));
    return formatDatasetLabel(modelKey);
  }, [datasetLabel, modelKey]);
  const backtestMethod = useMemo(() => formatMethodLabel(kpiMetrics?.metrics?.method), [kpiMetrics]);

  const insights = useMemo<InsightCard[]>(() => {
    const cards: InsightCard[] = [];

    const mape = kpiMetrics?.metrics?.mape_pct ?? null;
    const smape = kpiMetrics?.metrics?.smape_pct ?? null;
    const wape = kpiMetrics?.metrics?.wape_pct ?? null;
    const bias = kpiMetrics?.metrics?.bias_pct ?? null;
    const n = kpiMetrics?.metrics?.n ?? null;
    const method = formatMethodLabel(kpiMetrics?.metrics?.method);

    if (mape != null || wape != null || bias != null) {
      const absBias = bias == null ? null : Math.abs(bias);
      const status: InsightCard["status"] =
        wape != null && absBias != null && wape <= 8 && absBias <= 2
          ? "good"
          : wape != null && absBias != null && wape <= 15 && absBias <= 5
            ? "warn"
            : "bad";

      cards.push({
        title: "Prognosequalität",
        status,
        bullets: [
          `Validierung: ${method}`,
          wape == null ? "WAPE: —" : `WAPE: ${wape.toFixed(2)}% (Gesamtabweichung)`,
          smape == null ? "sMAPE: —" : `sMAPE: ${smape.toFixed(2)}% (stabil bei kleinen Mengen)`,
          mape == null ? "MAPE: —" : `MAPE: ${mape.toFixed(2)}% (Durchschnittsabweichung)`,
          bias == null
            ? "Bias: —"
            : `Bias: ${bias.toFixed(2)}% (${bias > 0 ? "tendenziell zu hoch" : "tendenziell zu tief"})`,
          n == null ? "Vergleichstage: —" : `Vergleichstage: ${n}`,
        ],
        footnote:
          status === "good"
            ? "Interpretation: Modell ist aktuell gut nutzbar."
            : status === "warn"
              ? "Interpretation: nutzbar, aber mit merklichen Schwankungen."
              : "Interpretation: kritisch – bitte Ursachenanalyse und Modell-Update prüfen.",
      });
    }

    if (weekly.length) {
      const ratios = weekly
        .map((w) => {
          if (w.p05 == null || w.p95 == null) return null;
          const band = Math.max(0, w.p95 - w.p05);
          const base = Math.max(1, w.forecast ?? 0);
          return band / base;
        })
        .filter((x): x is number => x != null && Number.isFinite(x));

      if (ratios.length) {
        const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
        const status: InsightCard["status"] = avg <= 0.12 ? "good" : avg <= 0.22 ? "warn" : "bad";
        cards.push({
          title: "Unsicherheitsband",
          status,
          bullets: [
            `Ø Bandbreite: ${(avg * 100).toFixed(1)}% relativ zum Forecast`,
            status === "good"
              ? "Enges Band -> gute Planbarkeit."
              : status === "warn"
                ? "Mittlere Unsicherheit -> Puffer einplanen."
                : "Hohe Unsicherheit -> Analyse der Treiber empfohlen.",
          ],
          footnote: "Band sichtbar, wenn p05/p95 Daten vorhanden sind.",
        });
      }
    }

    return cards;
  }, [kpiMetrics, weekly]);

  const [showQuantiles, setShowQuantiles] = useState(false);

  const combinedError = useMemo(() => {
    const parts: string[] = [];
    if (errors.series) parts.push(`Series: ${errors.series}`);
    if (errors.kpis) parts.push(`KPIs: ${errors.kpis}`);
    if (errors.dailyErrors) parts.push(`Daily Errors: ${errors.dailyErrors}`);
    if (errors.outliers) parts.push(`Outliers: ${errors.outliers}`);
    return parts.length ? parts.join(" · ") : null;
  }, [errors]);

  const goDecisionBoardForWeek = (week: string, scenario: "p50" | "p95" = "p50") => {
    const q = new URLSearchParams();
    if (runId) q.set("runId", runId);
    q.set("modelKey", modelKey);
    q.set("startDate", startDate);
    q.set("horizonDays", String(horizonDays));
    q.set("historyDays", String(historyDays));
    q.set("week", week);
    q.set("scenario", scenario);
    navigate(`/decision?${q.toString()}`);
  };

  const goDecisionBoard = () => {
    const firstWeek = weekly?.[0]?.week ?? "";
    const q = new URLSearchParams();
    if (runId) q.set("runId", runId);
    q.set("modelKey", modelKey);
    q.set("startDate", startDate);
    q.set("horizonDays", String(horizonDays));
    q.set("historyDays", String(historyDays));
    if (firstWeek) q.set("week", firstWeek);
    q.set("scenario", "p50");
    navigate(`/decision?${q.toString()}`);
  };

  const debugStats = useMemo(() => {
    const forecastMM = minMax(weekly.map((w) => (finiteNumber(w.forecast) ? w.forecast : null)));
    const actualMM = minMax(weekly.map((w) => (finiteNumber(w.actual) ? w.actual : null)));
    const p05MM = minMax(weekly.map((w) => (finiteNumber(w.p05) ? w.p05 : null)));
    const p95MM = minMax(weekly.map((w) => (finiteNumber(w.p95) ? w.p95 : null)));

    const invalid = {
      week: weekly.filter((w) => !w.week || typeof w.week !== "string").length,
      forecast: weekly.filter((w) => w.forecast != null && !Number.isFinite(Number(w.forecast))).length,
      actual: weekly.filter((w) => w.actual != null && !Number.isFinite(Number(w.actual))).length,
      p05: weekly.filter((w) => w.p05 != null && !Number.isFinite(Number(w.p05))).length,
      p95: weekly.filter((w) => w.p95 != null && !Number.isFinite(Number(w.p95))).length,
    };

    const maxBase = Math.max(1, forecastMM.max ?? 0, actualMM.max ?? 0);
    const p95Factor = p95MM.max != null ? p95MM.max / maxBase : null;

    return {
      weeklyLen: weekly.length,
      firstWeek: weekly[0] ?? null,
      minMax: {
        forecast: forecastMM,
        actual: actualMM,
        p05: p05MM,
        p95: p95MM,
      },
      invalid,
      p95Factor,
    };
  }, [weekly]);

  return (
    <div className="page">
      <div className="card">
        <div className="cardBody">
          <div className="pbHeader">
            <div>
              <div className="pbTitle">Prognose-Dashboard (PowerBI-Stil)</div>
              <div className="pbSubtitle">
                {datasetDisplayLabel}
                {rangeLabel ? ` · ${rangeLabel}` : ""}
              </div>
              {datasetLoadError ? (
                <div style={{ marginTop: 6, fontSize: 12, fontWeight: 800, color: "rgba(239,68,68,.85)" }}>
                  Datasets konnten nicht geladen werden (Fallback aktiv): {datasetLoadError}
                </div>
              ) : null}
            </div>

            <div className="pbToolbar">
              {!isRunMode && (
                <>
                  <select
                    className="input"
                    value={modelKey}
                    onChange={(e) => setModelKey(e.target.value as DatasetKey)}
                    title="Dataset"
                  >
                    {availableKeys.map((k) => (
                      <option key={k} value={k}>
                        {formatDatasetLabel(k)}
                      </option>
                    ))}
                  </select>

                  <input
                    className="input"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    title="Start Date"
                  />

                  <input
                    className="input"
                    style={{ minWidth: 120 }}
                    type="number"
                    min={7}
                    max={365}
                    value={historyDays}
                    onChange={(e) => setHistoryDays(Number(e.target.value))}
                    title="History (days)"
                  />

                  <input
                    className="input"
                    style={{ minWidth: 120 }}
                    type="number"
                    min={7}
                    max={365}
                    value={horizonDays}
                    onChange={(e) => setHorizonDays(Number(e.target.value))}
                    title="Horizon (days)"
                  />
                </>
              )}

              <button className="btn btn-primary" onClick={loadAll} disabled={isRunMode}>
                Daten laden
              </button>

              <button className="btn" onClick={() => setShowQuantiles((s) => !s)} disabled={!hasQuantiles}>
                {showQuantiles ? "Quantile ausblenden" : "Quantile anzeigen"}
              </button>

              <button
                className="btn"
                onClick={goDecisionBoard}
                disabled={loading.series || loading.kpis || !weekly?.length}
                title={!weekly?.length ? "Bitte zuerst Daten laden" : "Öffnet Decision Board mit aktuellen Parametern"}
              >
                Maßnahmenplan
              </button>

              <button className="btn" onClick={() => setShowDebug((s) => !s)} title="Debug-Overlay ein/aus">
                Debug
              </button>
            </div>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button className={granularity === "weekly" ? "btn btn-primary" : "btn"} onClick={() => setGranularity("weekly")}>
              Wöchentlich
            </button>
            <button className={granularity === "daily" ? "btn btn-primary" : "btn"} onClick={() => setGranularity("daily")}>
              Täglich
            </button>
            <span className="pill">Validierung: {backtestMethod}</span>
          </div>

          {combinedError ? (
            <div
              style={{
                marginTop: 12,
                borderRadius: 14,
                border: "1px solid rgba(239,68,68,.20)",
                background: "rgba(239,68,68,.08)",
                padding: "10px 12px",
                fontWeight: 800,
                color: "rgb(127, 29, 29)",
              }}
            >
              {combinedError}
            </div>
          ) : null}
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid" style={{ marginTop: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <KpiTile title="Prognose gesamt" value={formatKg(forecastTotal)} subtitle="aktueller Zeitraum" />
        <KpiTile title="Ist gesamt" value={formatKg(actualsTotal)} subtitle="verfügbare Historie" />
        <KpiTile title="WAPE" value={formatPct2(kpiMetrics?.metrics?.wape_pct ?? null)} subtitle="Gesamtabweichung" />
        <KpiTile title="sMAPE" value={formatPct2(kpiMetrics?.metrics?.smape_pct ?? null)} subtitle="stabiler Vergleich" />
        <KpiTile title="MAPE" value={formatPct2(kpiMetrics?.metrics?.mape_pct ?? null)} subtitle="durchschnittlich" />
        <KpiTile title="Bias" value={formatPct2(kpiMetrics?.metrics?.bias_pct ?? null)} subtitle="Richtung der Abweichung" />
        <KpiTile title="Sparpotenzial" value={formatMoney(Math.round(savingsTotal))} subtitle="CHF (Proxy)" />
      </div>

      {/* Insights */}
      {insights.length ? (
        <div className="grid" style={{ marginTop: 12, gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
          {insights.map((c) => (
            <div key={c.title} className="card">
              <div className="visualHeader">
                <div className="visualTitle">{c.title}</div>
                <span className={statusBadge(c.status)}>{c.status.toUpperCase()}</span>
              </div>
              <div className="visualBody">
                <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)", fontWeight: 750, fontSize: 13 }}>
                  {c.bullets.map((b) => (
                    <li key={b} style={{ marginBottom: 6 }}>
                      {b}
                    </li>
                  ))}
                </ul>
                {c.footnote ? (
                  <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: "var(--text-tertiary)" }}>
                    {c.footnote}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* Main visuals (2 columns) */}
      <div className="grid" style={{ marginTop: 12, gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
        {/* Volume */}
        <div className="card">
          <div className="visualHeader">
            <div>
              <div className="visualTitle">Verlauf & Prognose</div>
              <div className="visualMeta">
                {granularity === "daily" ? "Tägliche Ansicht" : "Wöchentliche Aggregation"} · Ist vs Prognose{" "}
                {hasQuantiles ? "· Konfidenzband" : ""}
              </div>
            </div>

            <HeaderLegend
              items={[
                { label: "Ist", color: "#1f8ef1", kind: "line" as const },
                { label: "Prognose", color: "rgba(71,85,105,.95)", kind: "line" as const },
                ...(hasQuantiles
                  ? [{ label: "Konfidenzband", color: "rgba(100,116,139,.16)", kind: "fill" as const }]
                  : []),
              ]}
            />
          </div>

          <div className="visualBody">
            <div className="chartBox">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={trendData}
                  margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                  onClick={(e: any) => {
                    const week = e?.activePayload?.[0]?.payload?.week ?? e?.activeLabel;
                    if (typeof week === "string" && week.length) goDecisionBoardForWeek(week, "p50");
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.18} />
                  <XAxis dataKey={trendXAxisKey} tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip content={<PbTooltip />} />

                  {hasQuantiles && showQuantiles && (
                    <>
                      <Area type="monotone" dataKey="p95" name="p95" fill="rgba(100,116,139,.16)" stroke="none" />
                      <Area type="monotone" dataKey="p05" name="p05" fill="rgba(100,116,139,.16)" stroke="none" />
                    </>
                  )}

                  <Line
                    type="monotone"
                    dataKey="actual"
                    name="actual"
                    stroke="#1f8ef1"
                    strokeWidth={2.2}
                    connectNulls
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="forecast"
                    name="forecast"
                    stroke="rgba(71,85,105,.95)"
                    strokeWidth={2.2}
                    connectNulls
                    dot={false}
                  />
                  {forecastStartLabel ? (
                    <ReferenceLine
                      x={forecastStartLabel}
                      stroke="rgba(100,116,139,.7)"
                      strokeDasharray="4 4"
                      label={{ value: "Forecast Start", position: "insideTopRight", fill: "rgba(71,85,105,.8)", fontSize: 11 }}
                    />
                  ) : null}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Opportunities */}
        <div className="card">
          <div className="visualHeader">
            <div>
              <div className="visualTitle">Kosten & Sparpotenzial</div>
              <div className="visualMeta">
                <span className="pill pillWarn" style={{ padding: "4px 8px", fontSize: 11 }}>
                  Proxy
                </span>{" "}
                aus Forecast- und Personalmodell
              </div>
            </div>

            <HeaderLegend
              items={[
                { label: "Kosten (Proxy)", color: "rgba(245,158,11,.55)", kind: "fill" },
                { label: "Sparpotenzial (Proxy)", color: "rgba(16,185,129,.55)", kind: "fill" },
              ]}
            />
          </div>

          <div className="visualBody">
            <div className="chartBox">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={operationsData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.18} />
                  <XAxis dataKey="week" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip content={<PbTooltip />} />
                  <Bar dataKey="planCostCHF" name="planCostCHF" fill="rgba(245,158,11,.55)" />
                  <Bar
                    dataKey="opportunities"
                    name="opportunities"
                    fill="rgba(16,185,129,.55)"
                    onClick={(data: any) => {
                      const week = data?.payload?.week;
                      if (typeof week === "string" && week.length) goDecisionBoardForWeek(week, "p50");
                    }}
                    style={{ cursor: "pointer" }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      {/* Outliers table */}
      {outliers.length ? (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="visualHeader">
            <div className="visualTitle">Auffällige Tage</div>
            <div className="visualMeta">sortiert nach prozentualer Abweichung (APE)</div>
          </div>

          <div className="visualBody tableWrap">
            <table className="table tableCompact">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="num">Actual</th>
                  <th className="num">Forecast</th>
                  <th className="num">Error</th>
                  <th className="num">Abs Error</th>
                  <th className="num">APE</th>
                </tr>
              </thead>
              <tbody>
                {outliers.map((d: DailyErrorPoint) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td className="num">{formatKg(d.actual)}</td>
                    <td className="num">{formatKg(d.forecast)}</td>
                    <td className="num">{formatKg(d.error)}</td>
                    <td className="num">{formatKg(d.abs_error)}</td>
                    <td className="num">{d.ape == null ? "—" : `${(d.ape * 100).toFixed(2)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Daily Errors */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="visualHeader">
          <div className="visualTitle">Abweichung (Ist vs Prognose)</div>
          <div className="visualMeta">
            Tage: {chartDailyErrors?.length ?? 0} {loading.dailyErrors ? "· lädt…" : ""}
          </div>
        </div>

        <div className="visualBody">
          <div className="chartBox">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartDailyErrors ?? []} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.18} />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip content={<PbTooltip />} />
                <ReferenceLine y={0} stroke="rgba(100,116,139,.45)" />
                <Line type="monotone" dataKey="error" name="error" dot={false} stroke="#1f8ef1" />
                <Line type="monotone" dataKey="abs_error" name="abs_error" dot={false} stroke="rgba(71,85,105,.95)" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Debug Overlay (unverändert) */}
      {showDebug ? (
        <div
          style={{
            position: "fixed",
            right: 12,
            bottom: 12,
            width: 420,
            maxWidth: "calc(100vw - 24px)",
            maxHeight: "calc(100vh - 24px)",
            overflow: "auto",
            borderRadius: 14,
            border: "1px solid rgba(15,23,42,.16)",
            background: "rgba(255,255,255,.92)",
            boxShadow: "0 10px 30px rgba(15,23,42,.18)",
            padding: 12,
            zIndex: 9999,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            fontSize: 12,
            lineHeight: 1.4,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontWeight: 900 }}>DEBUG · Forecast Binding</div>
            <button className="btn" onClick={() => setShowDebug(false)} style={{ padding: "4px 8px" }}>
              Close
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 900, marginBottom: 4 }}>Status</div>
              <div>weekly.length: {debugStats.weeklyLen}</div>
              <div>hasQuantiles: {String(hasQuantiles)}</div>
              <div>loading.series: {String(loading.series)}</div>
              <div>loading.kpis: {String(loading.kpis)}</div>
              <div>series error: {errors.series ? errorToString(errors.series) : "—"}</div>
            </div>

            <div>
              <div style={{ fontWeight: 900, marginBottom: 4 }}>Min/Max</div>
              <div>
                forecast: {debugStats.minMax.forecast.min ?? "—"} / {debugStats.minMax.forecast.max ?? "—"}
              </div>
              <div>
                actual: {debugStats.minMax.actual.min ?? "—"} / {debugStats.minMax.actual.max ?? "—"}
              </div>
              <div>
                p05: {debugStats.minMax.p05.min ?? "—"} / {debugStats.minMax.p05.max ?? "—"}
              </div>
              <div>
                p95: {debugStats.minMax.p95.min ?? "—"} / {debugStats.minMax.p95.max ?? "—"}
              </div>
              <div>
                p95Factor vs base(max):{" "}
                {debugStats.p95Factor == null || !Number.isFinite(debugStats.p95Factor)
                  ? "—"
                  : debugStats.p95Factor.toFixed(2) + "×"}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 900, marginBottom: 4 }}>Invalid / NaN counts</div>
            <div>
              week: {debugStats.invalid.week} · forecast: {debugStats.invalid.forecast} · actual: {debugStats.invalid.actual} ·
              p05: {debugStats.invalid.p05} · p95: {debugStats.invalid.p95}
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 900, marginBottom: 4 }}>weekly[0]</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
              {debugStats.firstWeek ? JSON.stringify(debugStats.firstWeek, null, 2) : "—"}
            </pre>
          </div>

          <div style={{ marginTop: 10, color: "rgba(15,23,42,.70)", fontWeight: 800 }}>
            Quick read:
            <ul style={{ margin: "6px 0 0 18px" }}>
              <li>weekly.length = 0 ⇒ Parser/Mapping liefert nichts (Step 2).</li>
              <li>Invalid/NaN &gt; 0 ⇒ Key-Mismatch / parseFloat / Date-Parsing (Step 2).</li>
              <li>p95Factor ≫ 1 (z.B. &gt;10×) ⇒ Skala drückt Forecast optisch platt (Step 3).</li>
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
