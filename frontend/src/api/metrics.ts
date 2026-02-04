// src/api/metrics.ts
import { apiGet, apiPost } from "./client";

export type DailyErrorPoint = {
  date: string; // YYYY-MM-DD
  actual: number;
  forecast: number;
  error: number; // forecast - actual
  abs_error: number;
  ape?: number | null;
};

export type MetricsResponse = {
  run_id?: string | null;
  model_key: string;
  window: {
    from: string;
    to: string;
    backtest_days: number;
  };
  metrics: {
    n: number;
    method?: string | null;
    method_error?: string | null;
    nonzero_actual_days?: number | null;
    zero_actual_days?: number | null;
    ape_denominator_floor?: number | null;
    mape_pct: number | null;
    smape_pct?: number | null;
    wape_pct: number | null;
    bias_pct: number | null;
  };
  daily_errors: DailyErrorPoint[];
};

export type LiveMetricsRequest = {
  start_date: string; // YYYY-MM-DD
  history_days: number;
  backtest_days: number;
};

export type MetricsQuery = {
  includeDailyErrors?: boolean;
  dailyErrorsLimit?: number;
  outliersOnly?: boolean;
  backtestDays?: number; // only for run endpoint
};

function buildQuery(q?: MetricsQuery): string {
  if (!q) return "";

  const params = new URLSearchParams();

  if (q.backtestDays !== undefined) {
    params.set("backtest_days", String(q.backtestDays));
  }
  if (q.includeDailyErrors !== undefined) {
    params.set("include_daily_errors", String(q.includeDailyErrors));
  }
  if (q.dailyErrorsLimit !== undefined) {
    params.set("daily_errors_limit", String(q.dailyErrorsLimit));
  }
  if (q.outliersOnly !== undefined) {
    params.set("outliers_only", String(q.outliersOnly));
  }

  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * metricsApi
 *
 * Backend (relative to BASE_URL="/api" in client.ts):
 *  - POST /metrics/{model_key}
 *  - GET  /metrics/runs/{run_id}
 */
export const metricsApi = {
  async getLiveMetrics(
    modelKey: string,
    req: LiveMetricsRequest,
    q?: MetricsQuery
  ): Promise<MetricsResponse> {
    return apiPost<MetricsResponse>(
      `/metrics/${encodeURIComponent(modelKey)}${buildQuery(q)}`,
      req
    );
  },

  async getRunMetrics(runId: string, q?: MetricsQuery): Promise<MetricsResponse> {
    return apiGet<MetricsResponse>(
      `/metrics/runs/${encodeURIComponent(runId)}${buildQuery(q)}`
    );
  },

  // -------- Convenience helpers --------

  // Chart braucht daily_errors => includeDailyErrors: true
  async getRunMetricsForChart(
    runId: string,
    backtestDays: number,
    dailyErrorsLimit = 120
  ): Promise<MetricsResponse> {
    return this.getRunMetrics(runId, {
      backtestDays,
      includeDailyErrors: true,
      dailyErrorsLimit,
      outliersOnly: false,
    });
  },

  async getRunMetricsOutliers(
    runId: string,
    backtestDays = 56,
    topN = 20
  ): Promise<MetricsResponse> {
    return this.getRunMetrics(runId, {
      backtestDays,
      includeDailyErrors: true,
      dailyErrorsLimit: topN,
      outliersOnly: true,
    });
  },

  // Chart braucht daily_errors => includeDailyErrors: true
  async getLiveMetricsForChart(
    modelKey: string,
    req: LiveMetricsRequest,
    dailyErrorsLimit = 120
  ): Promise<MetricsResponse> {
    return this.getLiveMetrics(modelKey, req, {
      includeDailyErrors: true,
      dailyErrorsLimit,
      outliersOnly: false,
    });
  },

  async getLiveMetricsOutliers(
    modelKey: string,
    req: LiveMetricsRequest,
    topN = 20
  ): Promise<MetricsResponse> {
    return this.getLiveMetrics(modelKey, req, {
      includeDailyErrors: true,
      dailyErrorsLimit: topN,
      outliersOnly: true,
    });
  },
};
