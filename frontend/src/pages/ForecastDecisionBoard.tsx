// src/pages/ForecastDecisionBoard.tsx
import React, { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Area,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";
import type { TooltipProps } from "recharts";

import type { ModelKey } from "../api/forecasts";
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
function formatPct0to100(x: number | null | undefined) {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${Math.round(x)}%`;
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

/** ---------- Decision model (uses same constants) ---------- */
const EFF = {
  hoursPerFteWeek: 40,
  kgPerFteWeek: 72_000,
  costPerHourCHF: 42,
  targetUtilizationPct: 95,
  minBaseFte: 0,
};

type Scenario = "p50" | "p95";
type RiskLevel = "good" | "warn" | "bad";

function riskFromBand(bandRatio: number): RiskLevel {
  if (!Number.isFinite(bandRatio)) return "warn";
  if (bandRatio <= 0.12) return "good";
  if (bandRatio <= 0.22) return "warn";
  return "bad";
}

function clampWeeks(weekly: WeeklyPoint[], max = 8) {
  return (weekly ?? []).slice(0, Math.max(0, max));
}

/** ---------- PowerBI-like Tooltip ---------- */
function pbLabel(label: any) {
  if (label == null) return "";
  return String(label);
}
function PbTooltip({ active, payload, label }: TooltipProps<any, any>) {
  if (!active || !payload?.length) return null;

  const rows = payload
    .filter((p) => p && p.value != null && p.name)
    .map((p) => ({
      name: String(p.name),
      value: p.value,
      color: p.color ?? "rgba(15,23,42,.35)",
    }));

  return (
    <div className="pbTooltip">
      <div className="pbTooltipTitle">{pbLabel(label)}</div>
      {rows.map((r) => (
        <div key={r.name} className="pbTooltipRow">
          <span className="pbTooltipDot" style={{ background: r.color }} />
          <span>{r.name}</span>
          <span className="pbTooltipValue">
            {r.name.toLowerCase().includes("kg") || r.name.toLowerCase().includes("demand") || r.name.toLowerCase().includes("forecast")
              ? formatKg(Number(r.value))
              : r.name.toLowerCase().includes("chf") || r.name.toLowerCase().includes("cost") || r.name.toLowerCase().includes("savings")
                ? formatMoney(Number(r.value))
                : Number(r.value).toFixed(2)}
          </span>
        </div>
      ))}
    </div>
  );
}

function statusBadge(status: RiskLevel) {
  if (status === "good") return "badge badge-success";
  if (status === "warn") return "badge badge-warning";
  return "badge badge-danger";
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

export default function ForecastDecisionBoard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const runId = searchParams.get("runId") ?? searchParams.get("run_id");
  const modelKey = (searchParams.get("modelKey") as ModelKey) ?? "export";
  const startDate = searchParams.get("startDate") ?? new Date().toISOString().slice(0, 10);
  const horizonDays = Number(searchParams.get("horizonDays") ?? 28);
  const historyDays = Number(searchParams.get("historyDays") ?? 90);
  const scenario = (searchParams.get("scenario") as Scenario) ?? "p50";

  const [selectedWeek, setSelectedWeek] = useState<string>(searchParams.get("week") ?? "");

  const backtestDays = 56;

  const {
    isRunMode,
    weekly,
    hasQuantiles,
    kpiMetrics,
    loading,
    errors,
    datasetLabel,
    rangeLabel,
    loadAll,
  } = useForecastDashboardData({
    runId,
    modelKey,
    startDate,
    horizonDays,
    historyDays,
    backtestDays,
    dailyErrorLimit: 0,
    outlierLimit: 0,
  });

  // ensure selectedWeek is valid once data arrives
  React.useEffect(() => {
    if (!weekly?.length) return;
    if (selectedWeek && weekly.some((w) => w.week === selectedWeek)) return;
    const w0 = weekly[0]?.week ?? "";
    setSelectedWeek(w0);
    if (w0) {
      const q = new URLSearchParams(searchParams);
      q.set("week", w0);
      setSearchParams(q, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekly?.length]);

  const combinedError = useMemo(() => {
    const parts: string[] = [];
    if (errors.series) parts.push(`Series: ${errors.series}`);
    if (errors.kpis) parts.push(`KPIs: ${errors.kpis}`);
    return parts.length ? parts.join(" · ") : null;
  }, [errors]);

  const weekOptions = useMemo(() => (weekly ?? []).map((w) => w.week), [weekly]);

  const selectedPoint = useMemo(() => {
    const w = selectedWeek || weekly?.[0]?.week;
    return (weekly ?? []).find((x) => x.week === w) ?? (weekly?.[0] ?? null);
  }, [weekly, selectedWeek]);

  // demand according to scenario
  const demandKg = useMemo(() => {
    if (!selectedPoint) return 0;
    if (scenario === "p95" && hasQuantiles && selectedPoint.p95 != null) return selectedPoint.p95;
    return selectedPoint.forecast ?? 0;
  }, [selectedPoint, scenario, hasQuantiles]);

  const baseForecastKg = useMemo(() => (selectedPoint?.forecast ?? 0), [selectedPoint]);
  const p95Kg = useMemo(() => (selectedPoint?.p95 ?? null), [selectedPoint]);

  // staffing recommendation from demand
  const decision = useMemo(() => {
    const requiredFTE = Math.max(EFF.minBaseFte, demandKg / EFF.kgPerFteWeek);
    const targetFTE = requiredFTE / (EFF.targetUtilizationPct / 100);
    const deltaFTE = targetFTE - requiredFTE;

    const hours = targetFTE * EFF.hoursPerFteWeek;
    const planCostCHF = hours * EFF.costPerHourCHF;

    // "Savings" here is proxy: planning inefficiency removed (same idea as existing dashboard)
    const savingsCHF = Math.max(0, deltaFTE) * EFF.hoursPerFteWeek * EFF.costPerHourCHF;

    const confidence = (() => {
      const wape = kpiMetrics?.metrics?.wape_pct;
      if (wape == null || !Number.isFinite(wape)) return null;
      // simple confidence mapping: higher WAPE -> lower confidence
      const c = Math.max(0.35, Math.min(0.95, 1 - wape / 40));
      return c;
    })();

    const bandRatio = (() => {
      if (!hasQuantiles) return null;
      const p05 = selectedPoint?.p05;
      const p95 = selectedPoint?.p95;
      const base = Math.max(1, selectedPoint?.forecast ?? 0);
      if (p05 == null || p95 == null) return null;
      return Math.max(0, p95 - p05) / base;
    })();

    const risk: RiskLevel = bandRatio == null ? "warn" : riskFromBand(bandRatio);

    const drivers: string[] = [];
    if (bandRatio != null) drivers.push(`Uncertainty band: ${Math.round(bandRatio * 100)}% of forecast`);
    const bias = kpiMetrics?.metrics?.bias_pct;
    if (bias != null && Number.isFinite(bias)) drivers.push(`Bias: ${bias.toFixed(2)}%`);
    const wape = kpiMetrics?.metrics?.wape_pct;
    if (wape != null && Number.isFinite(wape)) drivers.push(`WAPE: ${wape.toFixed(2)}%`);
    if (!drivers.length) drivers.push("Limited KPI coverage – load KPIs or check run mode.");

    return {
      requiredFTE,
      targetFTE,
      deltaFTE,
      planCostCHF,
      savingsCHF,
      confidence,
      risk,
      bandRatio,
      drivers: drivers.slice(0, 3),
    };
  }, [demandKg, hasQuantiles, selectedPoint, kpiMetrics]);

  // visual 1: next weeks demand vs capacity (weekly-level)
  const capacitySeries = useMemo(() => {
    const ws = clampWeeks(weekly ?? [], 8);
    return ws.map((w) => {
      const demand =
        scenario === "p95" && hasQuantiles && w.p95 != null
          ? w.p95
          : (w.forecast ?? 0);

      const requiredFTE = Math.max(EFF.minBaseFte, demand / EFF.kgPerFteWeek);
      const targetFTE = requiredFTE / (EFF.targetUtilizationPct / 100);

      // represent "capacity" as kg-per-week implied by target FTE
      const recommendedCapacityKg = targetFTE * EFF.kgPerFteWeek;
      const currentCapacityKg = requiredFTE * EFF.kgPerFteWeek;

      const gapKg = Math.max(0, demand - recommendedCapacityKg);

      return {
        week: w.week,
        "Demand (kg)": demand,
        "Current plan (kg)": currentCapacityKg,
        "Recommended capacity (kg)": recommendedCapacityKg,
        "Gap (kg)": gapKg,
      };
    });
  }, [weekly, scenario, hasQuantiles]);

  // visual 2: risk outlook (band ratio per week if quantiles exist)
  const riskOutlook = useMemo(() => {
    const ws = clampWeeks(weekly ?? [], 8);
    return ws.map((w) => {
      const base = Math.max(1, w.forecast ?? 0);
      const bandRatio =
        hasQuantiles && w.p05 != null && w.p95 != null ? Math.max(0, w.p95 - w.p05) / base : null;
      const risk: RiskLevel = bandRatio == null ? "warn" : riskFromBand(bandRatio);
      return {
        week: w.week,
        risk,
        "Band %": bandRatio == null ? null : bandRatio * 100,
      };
    });
  }, [weekly, hasQuantiles]);

  // visual 3: scenario delta p50 vs p95 for selected week (if available)
  const scenarioDelta = useMemo(() => {
    const p50 = baseForecastKg;
    const p95 = hasQuantiles && p95Kg != null ? p95Kg : null;

    const fteFromKg = (kg: number) => {
      const required = Math.max(EFF.minBaseFte, kg / EFF.kgPerFteWeek);
      const target = required / (EFF.targetUtilizationPct / 100);
      return target;
    };
    const costFromFte = (fte: number) => fte * EFF.hoursPerFteWeek * EFF.costPerHourCHF;

    const p50Fte = fteFromKg(p50);
    const p50Cost = costFromFte(p50Fte);

    const p95Fte = p95 == null ? null : fteFromKg(p95);
    const p95Cost = p95Fte == null ? null : costFromFte(p95Fte);

    return [
      {
        metric: "FTE",
        p50: p50Fte,
        p95: p95Fte,
      },
      {
        metric: "Cost (CHF)",
        p50: p50Cost,
        p95: p95Cost,
      },
    ];
  }, [baseForecastKg, p95Kg, hasQuantiles]);

  const onWeekChange = (w: string) => {
    setSelectedWeek(w);
    const q = new URLSearchParams(searchParams);
    q.set("week", w);
    setSearchParams(q, { replace: true });
  };

  const onScenarioChange = (s: Scenario) => {
    const q = new URLSearchParams(searchParams);
    q.set("scenario", s);
    setSearchParams(q, { replace: true });
  };

  return (
    <div className="page">
      {/* Header */}
      <div className="card">
        <div className="cardBody">
          <div className="pbHeader">
            <div>
              <div className="pbTitle">Forecast Decision Board</div>
              <div className="pbSubtitle">
                {datasetLabel}
                {rangeLabel ? ` · ${rangeLabel}` : ""}
                {isRunMode ? " · run mode" : ""}
              </div>
            </div>

            <div className="pbToolbar">
              <select
                className="input"
                value={selectedWeek}
                onChange={(e) => onWeekChange(e.target.value)}
                disabled={!weekOptions.length}
                title="Week"
              >
                {weekOptions.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>

              <select
                className="input"
                value={scenario}
                onChange={(e) => onScenarioChange(e.target.value as Scenario)}
                title="Scenario"
              >
                <option value="p50">Scenario p50</option>
                <option value="p95" disabled={!hasQuantiles}>
                  Scenario p95 {!hasQuantiles ? "(no quantiles)" : ""}
                </option>
              </select>

              <button className="btn btn-primary" onClick={loadAll} disabled={isRunMode}>
                Daten laden
              </button>

              <button className="btn" onClick={() => navigate("/forecast")} title="Zurück zum Forecast Report">
                Zurück
              </button>
            </div>
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

      {/* KPI Row (decision-focused) */}
      <div className="grid gridKpis" style={{ marginTop: 12 }}>
        <KpiTile
          title="Recommended FTE Δ"
          value={`${decision.deltaFTE >= 0 ? "+" : ""}${decision.deltaFTE.toFixed(2)} FTE`}
          subtitle={`for ${selectedPoint?.week ?? "—"}`}
        />
        <KpiTile
          title="Risk Status"
          value={decision.risk.toUpperCase()}
          subtitle={decision.bandRatio == null ? "no quantiles" : `band ${(decision.bandRatio * 100).toFixed(1)}%`}
        />
        <KpiTile
          title="Expected Savings"
          value={formatMoney(Math.round(decision.savingsCHF))}
          subtitle="CHF (Proxy)"
        />
        <KpiTile
          title="Confidence"
          value={decision.confidence == null ? "—" : formatPct0to100(decision.confidence * 100)}
          subtitle="based on KPIs"
        />
      </div>

      {/* Actions / Narrative */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="visualHeader">
          <div className="visualTitle">Recommended Actions</div>
          <span className={statusBadge(decision.risk)}>{decision.risk.toUpperCase()}</span>
        </div>
        <div className="visualBody">
          <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)", fontWeight: 750, fontSize: 13 }}>
            <li style={{ marginBottom: 6 }}>
              Plan for <b>{scenario.toUpperCase()}</b> demand: <b>{formatKg(demandKg)}</b> (selected week).
            </li>
            <li style={{ marginBottom: 6 }}>
              Adjust capacity by <b>{decision.deltaFTE >= 0 ? "+" : ""}{decision.deltaFTE.toFixed(2)} FTE</b> to stay within target utilization.
            </li>
            <li style={{ marginBottom: 6 }}>
              Primary drivers: {decision.drivers.join(" · ")}
            </li>
          </ul>
        </div>
      </div>

      {/* Visuals (max 3) */}
      <div className="grid" style={{ marginTop: 12, gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
        {/* 1) Capacity vs demand gap */}
        <div className="card">
          <div className="visualHeader">
            <div>
              <div className="visualTitle">Capacity vs Demand Gap</div>
              <div className="visualMeta">next weeks · scenario {scenario.toUpperCase()}</div>
            </div>
          </div>
          <div className="visualBody">
            <div className="chartBox">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={capacitySeries} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.18} />
                  <XAxis dataKey="week" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip content={<PbTooltip />} />
                  <Legend verticalAlign="top" align="right" height={24} />
                  <Area type="monotone" dataKey="Demand (kg)" name="Demand (kg)" fillOpacity={0.12} strokeWidth={2} />
                  <Bar dataKey="Current plan (kg)" name="Current plan (kg)" barSize={18} />
                  <Bar dataKey="Recommended capacity (kg)" name="Recommended capacity (kg)" barSize={18} />
                  <Line type="monotone" dataKey="Gap (kg)" name="Gap (kg)" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="grid" style={{ gridTemplateRows: "repeat(2, minmax(0,1fr))", gap: 12 }}>
          {/* 2) Risk outlook */}
          <div className="card">
            <div className="visualHeader">
              <div>
                <div className="visualTitle">Risk Outlook</div>
                <div className="visualMeta">p05/p95 band (if available)</div>
              </div>
              <span className={statusBadge(decision.risk)}>{decision.risk.toUpperCase()}</span>
            </div>
            <div className="visualBody">
              <div className="chartBox">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={riskOutlook} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.18} />
                    <XAxis dataKey="week" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip content={<PbTooltip />} />
                    <Bar dataKey="Band %" name="Band %" barSize={22} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* 3) Scenario delta */}
          <div className="card">
            <div className="visualHeader">
              <div>
                <div className="visualTitle">Scenario Delta</div>
                <div className="visualMeta">selected week · p50 vs p95</div>
              </div>
              {!hasQuantiles ? (
                <span className="pill pillWarn" style={{ padding: "4px 8px", fontSize: 11 }}>
                  no quantiles
                </span>
              ) : null}
            </div>
            <div className="visualBody">
              <div className="chartBox">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={scenarioDelta} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.18} />
                    <XAxis dataKey="metric" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip content={<PbTooltip />} />
                    <Legend verticalAlign="top" align="right" height={24} />
                    <Bar dataKey="p50" name="p50" barSize={18} />
                    <Bar dataKey="p95" name="p95" barSize={18} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* lightweight governance footer */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="visualHeader">
          <div className="visualTitle">Governance</div>
          <div className="visualMeta">parameters used for decision context</div>
        </div>
        <div className="visualBody" style={{ color: "var(--text-secondary)", fontWeight: 750, fontSize: 13 }}>
          Model: <b>{modelKey}</b> · Start: <b>{startDate}</b> · Horizon: <b>{horizonDays}d</b> · History: <b>{historyDays}d</b>
          {runId ? (
            <>
              {" "}· RunId: <b>{runId}</b>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
