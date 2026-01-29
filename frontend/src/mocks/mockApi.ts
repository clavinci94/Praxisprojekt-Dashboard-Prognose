// src/mocks/mockApi.ts

const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === "true";

export type MockRunStatus = "queued" | "running" | "success" | "failed" | "canceled";

export type MockRun = {
  id: string;
  status: MockRunStatus;
  message?: string | null;
  created_at: string; // ISO
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  dataset?: string | null;
};

export type MockKpiItem = { name: string; value: number; unit?: string | null };

export type MockSeriesPoint = {
  date: string; // YYYY-MM-DD
  iso_week: string; // YYYY-Www
  y_true?: number;
  y_pred?: number;
  y_p05?: number;
  y_p95?: number;
};

export type MockForecastResponse = {
  run: {
    id: string;
    dataset: string;
    model?: string | null;
    horizon_days?: number | null;
    created_at?: string | null;
    status?: MockRunStatus;
    error_message?: string | null;
  };
  kpis: MockKpiItem[];
  series: MockSeriesPoint[];
};

const RUNS_KEY = "clerion_mock_runs_v1";
const FC_PREFIX = "clerion_mock_forecast_v1:";

const nowIso = () => new Date().toISOString();

function uid() {
  return `mock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Storage abstraction:
 * - Browser: localStorage
 * - Node/Vite middleware: in-memory Map
 */
type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

const mem = new Map<string, string>();

function getStorage(): StorageLike {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ls = (globalThis as any)?.localStorage;
    if (ls && typeof ls.getItem === "function" && typeof ls.setItem === "function") {
      return ls as StorageLike;
    }
  } catch {
    // ignore
  }

  return {
    getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k, v) => {
      mem.set(k, v);
    },
    removeItem: (k) => {
      mem.delete(k);
    },
  };
}

const store = getStorage();

function readRuns(): MockRun[] {
  try {
    const raw = store.getItem(RUNS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MockRun[]) : [];
  } catch {
    return [];
  }
}

function writeRuns(runs: MockRun[]) {
  store.setItem(RUNS_KEY, JSON.stringify(runs));
}

function isoOffsetMinutes(minutesAgo: number) {
  const d = new Date(Date.now() - minutesAgo * 60_000);
  return d.toISOString();
}

function writeForecast(runId: string, payload: MockForecastResponse) {
  store.setItem(`${FC_PREFIX}${runId}`, JSON.stringify(payload));
}

function readForecast(runId: string): MockForecastResponse | null {
  try {
    const raw = store.getItem(`${FC_PREFIX}${runId}`);
    if (!raw) return null;
    return JSON.parse(raw) as MockForecastResponse;
  } catch {
    return null;
  }
}

/**
 * Seedet Beispiel-Prognosen, falls noch keine Runs existieren.
 */
function ensureSeedRuns() {
  const existing = readRuns();
  if (existing.length > 0) return;

  const seed: MockRun[] = [
    {
      id: "run_240108_001",
      dataset: "import",
      status: "success",
      message: "Abgeschlossen – Import Forecast KW 01–08 (ZRH)",
      created_at: isoOffsetMinutes(60 * 24 * 2 + 35),
      started_at: isoOffsetMinutes(60 * 24 * 2 + 33),
      finished_at: isoOffsetMinutes(60 * 24 * 2 + 28),
    },
    {
      id: "run_240108_002",
      dataset: "export",
      status: "success",
      message: "Abgeschlossen – Export Forecast KW 01–08 (ZRH)",
      created_at: isoOffsetMinutes(60 * 24 * 2 + 20),
      started_at: isoOffsetMinutes(60 * 24 * 2 + 18),
      finished_at: isoOffsetMinutes(60 * 24 * 2 + 12),
    },
    {
      id: "run_240108_003",
      dataset: "import",
      status: "running",
      message: "Prognose wird erstellt (Re-run nach Datenupdate)",
      created_at: isoOffsetMinutes(60 * 10 + 12),
      started_at: isoOffsetMinutes(60 * 10 + 8),
      finished_at: null,
    },
    {
      id: "run_240108_004",
      dataset: "import",
      status: "queued",
      message: "In Warteschlange – Peak-Season Szenario",
      created_at: isoOffsetMinutes(60 * 6 + 5),
      started_at: null,
      finished_at: null,
    },
    {
      id: "run_240108_005",
      dataset: "import",
      status: "failed",
      message: "Fehler – Datenvalidierung",
      created_at: isoOffsetMinutes(60 * 24 * 1 + 55),
      started_at: isoOffsetMinutes(60 * 24 * 1 + 53),
      finished_at: isoOffsetMinutes(60 * 24 * 1 + 52),
      error: "Schema mismatch: Spalte 'sum_weight' fehlte in 1 Datei.",
    },
    {
      id: "run_240108_006",
      dataset: "import",
      status: "success",
      message: "Abgeschlossen – Operativer Forecast inkl. Unsicherheitsband",
      created_at: isoOffsetMinutes(60 * 24 * 1 + 15),
      started_at: isoOffsetMinutes(60 * 24 * 1 + 14),
      finished_at: isoOffsetMinutes(60 * 24 * 1 + 9),
    },
    {
      id: "run_240108_007",
      dataset: "export",
      status: "canceled",
      message: "Abgebrochen – Parameter angepasst (neuer Horizon)",
      created_at: isoOffsetMinutes(60 * 24 * 3 + 10),
      started_at: isoOffsetMinutes(60 * 24 * 3 + 8),
      finished_at: isoOffsetMinutes(60 * 24 * 3 + 7),
    },
    {
      id: "run_240108_008",
      dataset: "import",
      status: "success",
      message: "Abgeschlossen – Baseline Forecast (Rolling 26W)",
      created_at: isoOffsetMinutes(60 * 24 * 4 + 40),
      started_at: isoOffsetMinutes(60 * 24 * 4 + 38),
      finished_at: isoOffsetMinutes(60 * 24 * 4 + 34),
    },
  ];

  writeRuns(seed);

  for (const r of seed) {
    if (r.status !== "success") continue;
    const series = makeSeries(26, 12);
    const kpis = computeKpis(series);

    const fc: MockForecastResponse = {
      run: {
        id: r.id,
        dataset: r.dataset ?? "import",
        model: "MockModel v1",
        horizon_days: 84,
        created_at: r.created_at,
        status: r.status,
        error_message: null,
      },
      kpis,
      series,
    };

    writeForecast(r.id, fc);
  }
}

// --- helpers ---

function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function isoWeek(d: Date) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const yyyy = date.getUTCFullYear();
  const ww = String(weekNo).padStart(2, "0");
  return `${yyyy}-W${ww}`;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function makeSeries(historyWeeks: number, forecastWeeks: number): MockSeriesPoint[] {
  const today = new Date();
  const start = addDays(today, -(historyWeeks * 7));

  const base = 850_000;
  const trendPerWeek = 12_000;
  const seasonAmp = 90_000;

  const pts: MockSeriesPoint[] = [];

  for (let i = 0; i < historyWeeks + forecastWeeks; i++) {
    const dt = addDays(start, i * 7);
    const w = i;

    const seasonal = Math.sin((2 * Math.PI * w) / 26) * seasonAmp;
    const trend = w * trendPerWeek;
    const noise = (Math.random() - 0.5) * 40_000;

    const level = clamp(base + trend + seasonal + noise, 350_000, 1_800_000);
    const isHistory = i < historyWeeks;

    const yTrue = isHistory ? Math.round(level) : undefined;

    const forecastNoise = (Math.random() - 0.5) * 20_000;
    const yPred = clamp(base + trend + seasonal + forecastNoise, 350_000, 1_800_000);

    const horizon = isHistory ? 0 : i - historyWeeks + 1;
    const bandWidth = 55_000 + horizon * 15_000;

    const p05 = clamp(yPred - bandWidth, 250_000, 1_800_000);
    const p95 = clamp(yPred + bandWidth, 250_000, 1_800_000);

    pts.push({
      date: dt.toISOString().slice(0, 10),
      iso_week: isoWeek(dt),
      y_true: yTrue,
      y_pred: Math.round(yPred),
      y_p05: Math.round(p05),
      y_p95: Math.round(p95),
    });
  }

  return pts;
}

function computeKpis(series: MockSeriesPoint[]): MockKpiItem[] {
  const lastActualIdx = (() => {
    for (let i = series.length - 1; i >= 0; i--) {
      if (typeof series[i].y_true === "number") return i;
    }
    return -1;
  })();

  const next4 = series
    .slice(lastActualIdx + 1, lastActualIdx + 1 + 4)
    .reduce((acc, p) => acc + (p.y_pred ?? 0), 0);

  const last = series[lastActualIdx];
  const prev = series[lastActualIdx - 1];

  const wowLast =
    last?.y_true && prev?.y_true ? ((last.y_true - prev.y_true) / prev.y_true) * 100 : 0;

  const next = series[lastActualIdx + 1];
  const wowNext =
    next?.y_pred && last?.y_true ? ((next.y_pred - last.y_true) / last.y_true) * 100 : 0;

  return [
    { name: "next_4_weeks_volume", value: next4, unit: "kg" },
    { name: "wow_pct_change_last_actual", value: wowLast, unit: "%" },
    { name: "wow_pct_change_next_week_forecast", value: wowNext, unit: "%" },
  ];
}

// --- public mock functions ---

export function mockListRuns(): MockRun[] {
  ensureSeedRuns();
  return readRuns().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export function mockCreateRun(params?: { dataset?: string }) {
  ensureSeedRuns();

  const dataset = params?.dataset ?? "import";
  const id = uid();

  const run: MockRun = {
    id,
    dataset,
    status: "success",
    message: "Prognose erstellt",
    created_at: nowIso(),
    started_at: nowIso(),
    finished_at: nowIso(),
  };

  writeRuns([run, ...readRuns()]);

  const series = makeSeries(26, 12);
  const kpis = computeKpis(series);

  const fc: MockForecastResponse = {
    run: {
      id,
      dataset,
      model: "MockModel v1",
      horizon_days: 84,
      created_at: run.created_at,
      status: "success",
      error_message: null,
    },
    kpis,
    series,
  };

  writeForecast(id, fc);
  return run;
}

export function mockRunForecast(runId: string): MockForecastResponse {
  ensureSeedRuns();

  const fc = readForecast(runId);
  if (fc) return fc;

  const created = mockCreateRun({ dataset: "import" });
  return readForecast(created.id)!;
}
