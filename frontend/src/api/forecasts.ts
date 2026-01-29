// src/api/forecasts.ts
import { apiPost } from "./client";

/**
 * Allowed model keys for:
 * POST /forecast/{model_key}
 * POST /series/{model_key}
 *
 * (client.ts prepends BASE_URL="/api" by default)
 */
export type ModelKey = "export" | "import" | "tra_export" | "tra_import";

export type ForecastRequest = {
  /** "YYYY-MM-DD" */
  start_date: string;
  /** Forecast horizon in days (e.g. 28) */
  horizon_days: number;
};

export type ForecastPoint = {
  /** "YYYY-MM-DD" (or ISO date) */
  date: string;
  /** numeric forecast value */
  forecast: number;
};

export type ForecastResponse = {
  forecast: ForecastPoint[];
  meta?: Record<string, unknown>;
};

/** ---------- Series (Actuals + Forecast) ---------- */
export type SeriesRequest = ForecastRequest & {
  /** how many history days (actuals) to include */
  history_days: number;
};

export type ActualPoint = {
  date: string;
  value: number;
};

export type ForecastPointWithBand = ForecastPoint & {
  /** optional quantiles from backend */
  p05?: number | null;
  p95?: number | null;
};

export type SeriesResponse = {
  meta?: Record<string, unknown>;
  actuals: ActualPoint[];
  forecast: ForecastPointWithBand[];
};

/** ---------- Validators ---------- */
function assertValidRequest(req: ForecastRequest) {
  if (!req || typeof req !== "object") throw new Error("ForecastRequest fehlt.");
  if (typeof req.start_date !== "string" || req.start_date.length < 8) {
    throw new Error(`Ungültiges start_date: ${String((req as any).start_date)}`);
  }
  if (!Number.isFinite(req.horizon_days) || req.horizon_days <= 0) {
    throw new Error(`Ungültiges horizon_days: ${String((req as any).horizon_days)}`);
  }
}

function assertValidSeriesRequest(req: SeriesRequest) {
  assertValidRequest(req);
  if (!Number.isFinite(req.history_days) || req.history_days <= 0) {
    throw new Error(`Ungültiges history_days: ${String((req as any).history_days)}`);
  }
}

/** ---------- Normalizers ---------- */
function normalizeForecastResponse(data: any): ForecastResponse {
  const arr = Array.isArray(data?.forecast) ? data.forecast : [];
  const forecast: ForecastPoint[] = arr
    .map((p: any) => ({
      date: String(p?.date ?? ""),
      forecast: Number(p?.forecast),
    }))
    .filter((p: ForecastPoint) => p.date.length > 0 && Number.isFinite(p.forecast));

  return {
    forecast,
    meta: typeof data?.meta === "object" && data?.meta ? data.meta : undefined,
  };
}

function normalizeSeriesResponse(data: any): SeriesResponse {
  const a = Array.isArray(data?.actuals) ? data.actuals : [];
  const f = Array.isArray(data?.forecast) ? data.forecast : [];

  const actuals: ActualPoint[] = a
    .map((p: any) => ({
      date: String(p?.date ?? ""),
      value: Number(p?.value),
    }))
    .filter((p: ActualPoint) => p.date.length > 0 && Number.isFinite(p.value));

  const forecast: ForecastPointWithBand[] = f
    .map((p: any) => ({
      date: String(p?.date ?? ""),
      forecast: Number(p?.forecast),
      p05: typeof p?.p05 === "number" ? Number(p.p05) : p?.p05 === null ? null : undefined,
      p95: typeof p?.p95 === "number" ? Number(p.p95) : p?.p95 === null ? null : undefined,
    }))
    .filter((p: ForecastPointWithBand) => p.date.length > 0 && Number.isFinite(p.forecast));

  return {
    actuals,
    forecast,
    meta: typeof data?.meta === "object" && data?.meta ? data.meta : undefined,
  };
}

/** ---------- API ---------- */
export const forecastsApi = {
  /**
   * Backend contract:
   * POST /api/forecast/{model_key}
   *
   * client.ts uses BASE_URL (default "/api"), so we call:
   * POST /forecast/{model_key}
   */
  async getForecast(modelKey: ModelKey, req: ForecastRequest): Promise<ForecastResponse> {
    assertValidRequest(req);
    const data = await apiPost<any>(`/forecast/${encodeURIComponent(modelKey)}`, req);
    return normalizeForecastResponse(data);
  },

  /**
   * Backend contract:
   * POST /api/series/{model_key}
   *
   * client.ts uses BASE_URL (default "/api"), so we call:
   * POST /series/{model_key}
   */
  async getSeries(modelKey: ModelKey, req: SeriesRequest): Promise<SeriesResponse> {
    assertValidSeriesRequest(req);
    const data = await apiPost<any>(`/series/${encodeURIComponent(modelKey)}`, req);
    return normalizeSeriesResponse(data);
  },
};
