// src/api/types.ts

export type RunStatus = "queued" | "running" | "success" | "failed" | "canceled";

export type Run = {
  id: string;
  status: RunStatus;
  message?: string | null;

  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;

  dataset?: string | null;
  model?: string | null;

  error?: string | null;
};

// Forecast API (normalized)
export type ForecastRun = {
  run_id: string;
  dataset: string;
  model?: string;
  horizon?: number;
  granularity?: string;
  lookback_days?: number;
  created?: string;
};

export type ForecastKpi = {
  name: string;
  value: number;
  unit?: string;
};

export type ForecastPoint = {
  x: string; // ISO timestamp or date label
  y: number; // actual (if present)
  yhat?: number; // forecast
  lo?: number; // lower bound (p05)
  hi?: number; // upper bound (p95)
};

export type ForecastSeries = {
  name: string;
  unit?: string;
  points: ForecastPoint[];
};

export type ForecastResponse = {
  run: ForecastRun;
  kpis: ForecastKpi[];
  series: ForecastSeries[];
};
export type ForecastPoint = {
  date: string;      // YYYY-MM-DD
  forecast: number;  // float
};

export type ForecastResponse = {
  model: string;
  start_date: string;
  horizon_days: number;
  forecast: ForecastPoint[];
};
