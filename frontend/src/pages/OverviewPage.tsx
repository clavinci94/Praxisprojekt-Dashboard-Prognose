// src/pages/OverviewPage.tsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";

import type { ModelKey } from "../api/forecasts";
import { useForecastDashboardData } from "../hooks/useForecastDashboardData";

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

type KpiTone = "neutral" | "success" | "warn" | "danger";
function badgeCls(tone: KpiTone) {
  if (tone === "success") return "badge badge-success";
  if (tone === "warn") return "badge badge-warning";
  if (tone === "danger") return "badge badge-danger";
  return "badge";
}
function toneFromWape(wape: number | null | undefined): KpiTone {
  if (wape == null || !Number.isFinite(wape)) return "neutral";
  if (wape <= 8) return "success";
  if (wape <= 15) return "warn";
  return "danger";
}

/* ---------------- datasets (backend returns ARRAY) ---------------- */

type DatasetKey = "export" | "import" | "tra_export" | "tra_import";
type DatasetMeta = { key: string; data_from?: string; data_to?: string; points?: number };
type DatasetsResponse = { available?: DatasetMeta[] };

async function fetchDatasets(): Promise<DatasetKey[]> {
  const res = await fetch("/api/datasets");
  if (!res.ok) throw new Error(`GET /api/datasets failed (${res.status})`);
  const json = (await res.json()) as DatasetsResponse;

  const allowed: DatasetKey[] = ["export", "import", "tra_export", "tra_import"];
  const keys = (json.available ?? []).map((d) => d.key).filter(Boolean) as string[];
  const filtered = keys.filter((k) => allowed.includes(k as DatasetKey)) as DatasetKey[];
  return filtered.length ? filtered : allowed;
}


/* ---------------- page ---------------- */

export default function OverviewPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const runId = searchParams.get("runId") ?? searchParams.get("run_id");
  const isRunMode = !!runId;

  const [availableKeys, setAvailableKeys] = useState<DatasetKey[]>(["export", "import", "tra_export", "tra_import"]);
  const [datasetLoadError, setDatasetLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchDatasets()
      .then((keys) => {
        setAvailableKeys(keys);
        setDatasetLoadError(null);
      })
      .catch((e) => {
        setDatasetLoadError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  const [modelKey, setModelKey] = useState<DatasetKey>("export");
  const [startDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [horizonDays] = useState<number>(28);
  const [historyDays] = useState<number>(90);

  const data = useForecastDashboardData({
    runId: runId ?? undefined,
    modelKey: modelKey as unknown as ModelKey,
    startDate,
    horizonDays,
    historyDays,
    backtestDays: 56,
    dailyErrorLimit: 120,
    outlierLimit: 20,
  });

  const weekly = Array.isArray(data.weekly) ? data.weekly : [];
  const staffing = Array.isArray((data as any).staffing) ? (data as any).staffing : [];
  const outliers = Array.isArray((data as any).outliers) ? (data as any).outliers : [];

  const hasQuantiles = Boolean((data as any).hasQuantiles);
  const savingsTotal = Number.isFinite((data as any).savingsTotal) ? (data as any).savingsTotal : 0;

  const kpiMetrics = (data as any).kpiMetrics ?? null;
  const loading = (data as any).loading ?? { series: false };
  const errors = (data as any).errors ?? {};
  const loadAll = (data as any).loadAll ?? (() => {});

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, modelKey]);

  const totals = useMemo(() => {
    const forecastSum = weekly.reduce((a: number, p: any) => a + (p.forecast ?? 0), 0);
    const actualSum = weekly.reduce((a: number, p: any) => a + (p.actual ?? 0), 0);
    const hasAnyActual = weekly.some((p: any) => p.actual != null);
    const horizonWeeks = weekly.length;

    const avgUtil =
      staffing.length > 0 ? staffing.reduce((a: number, r: any) => a + r.utilizationPct, 0) / staffing.length : null;

    const topOutlier = outliers?.[0] ?? null;

    return { forecastSum, actualSum, hasAnyActual, horizonWeeks, avgUtil, topOutlier };
  }, [weekly, staffing, outliers]);

  const wapeTone = toneFromWape(kpiMetrics?.metrics?.wape_pct);

  const canRenderChart = weekly.length > 0;
  const showBand = hasQuantiles;

  return (
    <div className="page space-y-4">
      {/* Header */}
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="badge">Cockpit</span>
              {isRunMode ? <span className="badge badge-warning">Run</span> : <span className="badge">Live</span>}

              <select
                className="input"
                value={modelKey}
                onChange={(e) => setModelKey(e.target.value as DatasetKey)}
                title="Dataset"
                style={{ height: 28 }}
              >
                {availableKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>

              {showBand ? (
                <span className="badge badge-success">p05/p95</span>
              ) : (
                <span className="badge">ohne Quantile</span>
              )}
            </div>

            <h1 className="mt-3 text-lg font-extrabold tracking-tight text-text-primary">Executive Overview</h1>
            <div className="mt-1 text-sm font-medium text-secondary">
              Trends aus Actuals + Forecast (Weekly Aggregation)
            </div>

            {datasetLoadError ? (
              <div className="mt-2 text-xs font-semibold text-tertiary">
                Datasets konnten nicht geladen werden (Fallback aktiv):{" "}
                <span className="font-mono">{datasetLoadError}</span>
              </div>
            ) : null}

            {isRunMode ? (
              <div className="mt-2 text-xs font-semibold text-tertiary">
                Run-Ansicht · runId: <span className="font-mono">{runId}</span>
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              className="btn"
              type="button"
              onClick={() => navigate("/forecast" + (runId ? `?run_id=${encodeURIComponent(runId)}` : ""))}
            >
              Open Dashboard
            </button>

            <button className="btn btn-primary" type="button" onClick={() => navigate("/")}>
              Manage Runs
            </button>

            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => loadAll()}
              disabled={loading.series}
              title="Refresh (lokal)"
            >
              {loading.series ? "Aktualisiere…" : "Refresh"}
            </button>
          </div>
        </div>

        {/* IMPORTANT: only show blocking error (series) */}
        {errors.series ? (
          <div className="mt-3 space-y-2">
            <div className="text-sm font-semibold text-secondary">Series: {errors.series}</div>
          </div>
        ) : null}
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          title="Forecast (Summe)"
          value={canRenderChart ? formatKg(totals.forecastSum) : "—"}
          subtitle={canRenderChart ? `${totals.horizonWeeks} Wochen` : "Keine Daten"}
        />

        <KpiCard
          title="Actuals (Summe)"
          value={totals.hasAnyActual ? formatKg(totals.actualSum) : "—"}
          subtitle={totals.hasAnyActual ? "nur Wochen mit Actuals" : "keine Actuals geliefert"}
        />

        <KpiCard
          title={`WAPE (${kpiMetrics ? "Backtest" : "—"})`}
          value={formatPct2(kpiMetrics?.metrics?.wape_pct)}
          badge={wapeTone === "neutral" ? undefined : wapeTone.toUpperCase()}
          badgeTone={wapeTone}
          subtitle="(Backend-KPIs aktuell nicht aktiv)"
        />

        <KpiCard title="CHF Potential (Proxy)" value={staffing.length ? formatMoney(savingsTotal) : "—"} subtitle="Staffing-Modell" />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        {/* Trend Chart */}
        <div className="card lg:col-span-3 p-4" style={{ minHeight: 380, display: "flex", flexDirection: "column" }}>
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <h2 className="text-base font-extrabold tracking-tight text-text-primary">Forecast Trend</h2>
              <div className="text-xs font-semibold text-tertiary">Weekly Aggregation</div>
            </div>

            <div className="flex items-center gap-2">
              {loading.series ? <span className="badge">Lade Series…</span> : null}
              {showBand ? <span className="badge badge-success">Band aktiv</span> : <span className="badge">Band aus</span>}
            </div>
          </div>

          <div className="mt-3 flex-1">
            {!canRenderChart ? (
              <div className="text-sm font-semibold text-secondary">{loading.series ? "Lade Daten…" : "Keine Daten vorhanden."}</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={weekly} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.25} />
                  <XAxis dataKey="week" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Legend />

                  {showBand ? (
                    <>
                      <Area type="monotone" dataKey="p95" name="p95" stroke="currentColor" fill="currentColor" fillOpacity={0.08} dot={false as any} isAnimationActive={false} />
                      <Area type="monotone" dataKey="p05" name="p05" stroke="currentColor" fill="var(--surface)" fillOpacity={1} dot={false as any} isAnimationActive={false} />
                    </>
                  ) : null}

                  <Line type="monotone" dataKey="forecast" name="Forecast" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="actual" name="Actual" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          {!showBand ? (
            <div className="mt-3 text-xs font-semibold text-tertiary">Hinweis: p05/p95 nicht vorhanden → kein Unsicherheitsband.</div>
          ) : null}
        </div>

        {/* Signals */}
        <div className="card lg:col-span-1 p-4" style={{ display: "flex", flexDirection: "column" }}>
          <div className="flex items-baseline justify-between">
            <h2 className="text-base font-extrabold tracking-tight text-text-primary">Signals</h2>
          </div>

          <div className="mt-3 space-y-3">
            <div className="rounded-2xl border p-3" style={{ borderColor: "var(--border)" }}>
              <div className="text-xs font-extrabold uppercase tracking-wide text-tertiary">Top Outlier</div>
              <div className="mt-2 text-sm font-semibold text-secondary">Aktuell nicht aktiv (Outlier API fehlt im Backend).</div>
            </div>

            <div className="rounded-2xl border p-3" style={{ borderColor: "var(--border)" }}>
              <div className="text-xs font-extrabold uppercase tracking-wide text-tertiary">Kapazität</div>
              <div className="mt-2 text-sm font-semibold text-secondary">
                <div>
                  Ø Auslastung:{" "}
                  <span className="text-text-primary">{totals.avgUtil == null ? "—" : `${totals.avgUtil.toFixed(1)}%`}</span>
                </div>
                <div className="mt-1 text-xs font-semibold text-tertiary">Proxy aus Staffing-Modell (keine HR-Quelle).</div>
              </div>
            </div>

            <div className="rounded-2xl border p-3" style={{ borderColor: "var(--border)" }}>
              <div className="text-xs font-extrabold uppercase tracking-wide text-tertiary">Modellgüte</div>
              <div className="mt-2 text-sm font-semibold text-secondary">
                <div>MAPE: <span className="text-text-primary">{formatPct2(kpiMetrics?.metrics?.mape_pct)}</span></div>
                <div className="mt-1">Bias: <span className="text-text-primary">{formatPct2(kpiMetrics?.metrics?.bias_pct)}</span></div>
              </div>
            </div>
          </div>

          <div className="mt-auto pt-4">
            <button className="btn" style={{ width: "100%" }} type="button" onClick={() => navigate("/forecast" + (runId ? `?run_id=${encodeURIComponent(runId)}` : ""))}>
              Details öffnen
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  title,
  value,
  subtitle,
  badge,
  badgeTone = "neutral",
}: {
  title: string;
  value: string;
  subtitle?: string;
  badge?: string;
  badgeTone?: KpiTone;
}) {
  return (
    <div className="card p-4">
      <div className="text-sm font-extrabold text-text-primary">{title}</div>
      <div className="mt-2 text-2xl font-extrabold tracking-tight text-text-primary">{value}</div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-semibold">
        {badge ? <span className={badgeCls(badgeTone)}>{badge}</span> : null}
        {subtitle ? <span className="text-secondary">{subtitle}</span> : null}
      </div>
    </div>
  );
}
