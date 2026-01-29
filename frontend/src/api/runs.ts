// src/api/runs.ts
import { apiGet, apiPost } from "./client";
import type { Run } from "./types";

type RunsResponse = Run[] | { items: Run[] } | { data: Run[] };

/**
 * CreateRunRequest
 * Optional fields, because the UI may call create({})
 * and the backend applies defaults.
 */
export type CreateRunRequest = {
  model_key?: string;
  start_date?: string; // YYYY-MM-DD
  horizon_days?: number;
  history_days?: number;
  tags?: Record<string, string>;
};

export type SeriesActualPoint = {
  date: string;
  value: number;
};

export type SeriesForecastPoint = {
  date: string;
  forecast: number;
  p05?: number | null;
  p95?: number | null;
};

export type RunSeriesResponse = {
  meta: Record<string, unknown>;
  actuals: SeriesActualPoint[];
  forecast: SeriesForecastPoint[];
};

export type RunMetricsResponse = {
  run_id: string;
  model_key: string;
  window: {
    from: string;
    to: string;
    backtest_days: number;
  };
  metrics: {
    n: number;
    mape_pct: number | null;
    wape_pct: number | null;
    bias_pct: number | null;
  };
};

export const runsApi = {
  async list(): Promise<Run[]> {
    const res = await apiGet<RunsResponse>("/runs");
    if (Array.isArray(res)) return res;
    if ("items" in res && Array.isArray(res.items)) return res.items;
    if ("data" in res && Array.isArray(res.data)) return res.data;
    return [];
  },

  async create(body: CreateRunRequest): Promise<Run> {
    return apiPost<Run>("/runs", body);
  },

  async get(runId: string): Promise<Run> {
    return apiGet<Run>(`/runs/${encodeURIComponent(runId)}`);
  },

  async getSeries(runId: string): Promise<RunSeriesResponse> {
    return apiGet<RunSeriesResponse>(
      `/runs/${encodeURIComponent(runId)}/series`
    );
  },

  async getMetrics(
    runId: string,
    backtestDays: number = 56
  ): Promise<RunMetricsResponse> {
    const params = new URLSearchParams({
      backtest_days: String(backtestDays),
    });
    return apiGet<RunMetricsResponse>(
      `/runs/${encodeURIComponent(runId)}/metrics?${params.toString()}`
    );
  },
};
