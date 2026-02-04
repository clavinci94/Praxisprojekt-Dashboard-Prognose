from __future__ import annotations

import json
import os
import sqlite3
from datetime import date as date_type
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Literal, Optional
from uuid import uuid4

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.db import get_conn, init_db
from app.services.data_loader import load_daily_weight_series

router = APIRouter(prefix="/runs", tags=["runs"])


RunStatus = Literal["queued", "running", "success", "failed", "canceled"]

# -------------------------------------------------------------------
# Config
# -------------------------------------------------------------------
DEFAULT_DATA_DIR = Path(
    os.getenv(
        "CARGOLOGIC_DATA_DIR",
        os.getenv(
            "CL_DATA_DIR",
            str(Path.home() / "Desktop" / "Projekt Cargologic"),
        ),
    )
).expanduser()

REQUIRED_FILES = [
    "cl_export.csv",
    "cl_import.csv",
    "cl_tra_export.csv",
    "cl_tra_import.csv",
]
# de-dup in case of typos
REQUIRED_FILES = list(dict.fromkeys(REQUIRED_FILES))

DATE_COL = os.getenv("CL_DATE_COL", "fl_gmt_departure_date")
VALUE_COL = os.getenv("CL_VALUE_COL", "weight_sum")

DEFAULT_MODEL_KEY = os.getenv("CL_DEFAULT_MODEL_KEY", "export")
DEFAULT_HORIZON_DAYS = int(os.getenv("CL_FORECAST_HORIZON_DAYS", "28"))
DEFAULT_HISTORY_DAYS = int(os.getenv("CL_HISTORY_DAYS", "90"))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def today_iso_date() -> str:
    return date_type.today().isoformat()


def parse_iso_date(s: str) -> date_type:
    return date_type.fromisoformat(s)


def _safe_div(num: float, den: float) -> float:
    return num / den if den != 0 else 0.0


# -------------------------------------------------------------------
# API Models
# -------------------------------------------------------------------
class RunParams(BaseModel):
    model_key: str = Field(default=DEFAULT_MODEL_KEY, description="export|import|tra_export|tra_import")
    start_date: str = Field(default_factory=today_iso_date, description="YYYY-MM-DD")
    horizon_days: int = Field(default=DEFAULT_HORIZON_DAYS, ge=1, le=3650)
    history_days: int = Field(default=DEFAULT_HISTORY_DAYS, ge=1, le=3650)
    tags: Optional[Dict[str, str]] = None

    @field_validator("start_date")
    @classmethod
    def _validate_start_date(cls, v: str) -> str:
        parse_iso_date(v)
        return v

class DailyErrorPoint(BaseModel):
    date: str
    actual: float
    forecast: float
    error: float          # forecast - actual
    abs_error: float
    ape: Optional[float] = None  # abs(error)/abs(actual) if actual!=0

class MetricsResponse(BaseModel):
    run_id: str
    model_key: str
    window: Dict[str, Any]
    metrics: Dict[str, Any]
    daily_errors: List[DailyErrorPoint]


class Run(BaseModel):
    id: str
    status: RunStatus
    created_at: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    message: Optional[str] = None
    error: Optional[str] = None
    params: Optional[RunParams] = None
    links: Optional[Dict[str, str]] = None


class CreateRunRequest(BaseModel):
    # Backwards compatible with UI calling create({}).
    model_key: Optional[str] = Field(default=None, description="export|import|tra_export|tra_import")
    start_date: Optional[str] = Field(default=None, description="YYYY-MM-DD")
    horizon_days: Optional[int] = Field(default=None, ge=1, le=3650)
    history_days: Optional[int] = Field(default=None, ge=1, le=3650)
    tags: Optional[Dict[str, str]] = None

    @field_validator("start_date")
    @classmethod
    def _validate_start_date_opt(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        parse_iso_date(v)
        return v


class SeriesActualPoint(BaseModel):
    date: str
    value: float


class SeriesForecastPoint(BaseModel):
    date: str
    forecast: float
    p05: Optional[float] = None
    p95: Optional[float] = None


class SeriesResponse(BaseModel):
    meta: Dict[str, Any]
    actuals: List[SeriesActualPoint]
    forecast: List[SeriesForecastPoint]


# Legacy forecast contract (kept)
class ForecastPoint(BaseModel):
    timestamp: str  # YYYY-MM-DD
    actual: Optional[float] = None
    forecast: float
    p05: float
    p95: float


class ForecastResponse(BaseModel):
    run_id: str
    generated_at: str
    series: List[ForecastPoint]


class MetricsResponse(BaseModel):
    run_id: str
    model_key: str
    window: Dict[str, Any]
    metrics: Dict[str, Any]


def _links_for(run_id: str) -> Dict[str, str]:
    return {
        "self": f"/api/runs/{run_id}",
        "series": f"/api/runs/{run_id}/series",
        "forecast": f"/api/runs/{run_id}/forecast",
        "metrics": f"/api/runs/{run_id}/metrics",
    }


# -------------------------------------------------------------------
# DB init (Step 2)
# -------------------------------------------------------------------
init_db()


# -------------------------------------------------------------------
# CSV loading -> daily sum series
# -------------------------------------------------------------------
def _resolve_csv_paths() -> List[Path]:
    paths = [DEFAULT_DATA_DIR / fn for fn in REQUIRED_FILES]
    missing = [str(p) for p in paths if not p.exists()]
    if missing:
        raise FileNotFoundError(
            "Missing required CSV files:\n"
            + "\n".join(missing)
            + f"\n\nDATA_DIR is: {DEFAULT_DATA_DIR}\n"
            + "Fix: set CARGOLOGIC_DATA_DIR (or CL_DATA_DIR) to the folder containing the four CSVs."
        )
    return paths


def load_daily_series_from_csvs() -> pd.DataFrame:
    """
    Reads all 4 CSVs, concatenates, aggregates VALUE_COL per day.
    Returns columns: date (YYYY-MM-DD), value (float)
    """
    paths = _resolve_csv_paths()

    frames: List[pd.DataFrame] = []
    for p in paths:
        df = pd.read_csv(p)
        if DATE_COL not in df.columns:
            raise ValueError(f"CSV {p.name}: missing DATE_COL={DATE_COL}")
        if VALUE_COL not in df.columns:
            raise ValueError(f"CSV {p.name}: missing VALUE_COL={VALUE_COL}")

        tmp = df[[DATE_COL, VALUE_COL]].copy()
        tmp[DATE_COL] = pd.to_datetime(tmp[DATE_COL], errors="coerce", utc=True).dt.tz_convert(None)
        tmp = tmp.dropna(subset=[DATE_COL])

        tmp.rename(columns={DATE_COL: "date", VALUE_COL: "value"}, inplace=True)
        frames.append(tmp)

    all_df = pd.concat(frames, ignore_index=True)
    daily = all_df.groupby("date", as_index=False)["value"].sum().sort_values("date")
    daily["date"] = pd.to_datetime(daily["date"]).dt.date.astype(str)
    daily["value"] = daily["value"].astype(float)
    return daily


def load_daily_series_for_model(model_key: str) -> pd.DataFrame:
    s = load_daily_weight_series(model_key, target_col="sum_weight")
    idx = pd.to_datetime(s.index)
    if isinstance(idx, pd.DatetimeIndex) and idx.tz is not None:
        idx = idx.tz_convert("UTC").tz_localize(None)
    out = pd.DataFrame({"date": idx.date.astype(str), "value": pd.to_numeric(s.values, errors="coerce")})
    out["value"] = out["value"].fillna(0.0).astype(float)
    return out.sort_values("date")


def _continuous_daily(df: pd.DataFrame, start: date_type, end: date_type) -> pd.DataFrame:
    """Ensure continuous daily index between start..end. Missing days filled with 0.0."""
    if start > end:
        return pd.DataFrame({"date": [], "value": []})

    dfi = df.copy()
    dfi["date"] = pd.to_datetime(dfi["date"])
    dfi = dfi.set_index("date").sort_index()

    idx = pd.date_range(start=start, end=end, freq="D")
    dfi = dfi.reindex(idx)
    dfi["value"] = dfi["value"].fillna(0.0).astype(float)
    out = dfi.reset_index().rename(columns={"index": "date"})
    out["date"] = out["date"].dt.date.astype(str)
    return out


# -------------------------------------------------------------------
# Builders
# -------------------------------------------------------------------
def _normalize_params(req: CreateRunRequest) -> RunParams:
    return RunParams(
        model_key=req.model_key or DEFAULT_MODEL_KEY,
        start_date=req.start_date or today_iso_date(),
        horizon_days=req.horizon_days or DEFAULT_HORIZON_DAYS,
        history_days=req.history_days or DEFAULT_HISTORY_DAYS,
        tags=req.tags,
    )


def build_series_from_params(run_id: str, p: RunParams) -> SeriesResponse:
    daily_df = load_daily_series_for_model(p.model_key)

    start = parse_iso_date(p.start_date)
    actuals_end = start - timedelta(days=1)
    actuals_start = actuals_end - timedelta(days=p.history_days - 1)

    raw_dates = pd.to_datetime(daily_df["date"]).dt.date
    mask = (raw_dates >= actuals_start) & (raw_dates <= actuals_end)
    hist_df = daily_df.loc[mask, ["date", "value"]].copy()
    hist_df_cont = _continuous_daily(hist_df, actuals_start, actuals_end)

    actuals: List[SeriesActualPoint] = [
        SeriesActualPoint(date=str(r["date"]), value=float(r["value"]))
        for _, r in hist_df_cont.iterrows()
    ]

    last_val = float(hist_df_cont["value"].iloc[-1]) if len(hist_df_cont) else 0.0

    forecast: List[SeriesForecastPoint] = []
    for i in range(p.horizon_days):
        d = (start + timedelta(days=i)).isoformat()
        f = max(0.0, last_val)
        forecast.append(SeriesForecastPoint(date=d, forecast=f, p05=f * 0.9, p95=f * 1.1))

    # Meta enrichment (for dashboard rangeLabel + audit)
    actuals_from = actuals[0].date if len(actuals) else None
    actuals_to = actuals[-1].date if len(actuals) else None
    forecast_from = forecast[0].date if len(forecast) else None
    forecast_to = forecast[-1].date if len(forecast) else None

    meta: Dict[str, Any] = {
        "run_id": run_id,
        "model_key": p.model_key,
        "dataset": "runs_db",
        "generated_at": now_iso(),
        "actuals_from": actuals_from,
        "actuals_to": actuals_to,
        "forecast_from": forecast_from,
        "forecast_to": forecast_to,
        "params": {
            "model_key": p.model_key,
            "start_date": p.start_date,
            "horizon_days": p.horizon_days,
            "history_days": p.history_days,
            "tags": p.tags or {},
        },
    }

    return SeriesResponse(meta=meta, actuals=actuals, forecast=forecast)


def build_legacy_forecast_from_series(sr: SeriesResponse) -> ForecastResponse:
    pts: List[ForecastPoint] = []

    for a in sr.actuals:
        pts.append(
            ForecastPoint(
                timestamp=a.date,
                actual=a.value,
                forecast=a.value,
                p05=a.value,
                p95=a.value,
            )
        )

    for f in sr.forecast:
        p05 = float(f.p05 if f.p05 is not None else f.forecast)
        p95 = float(f.p95 if f.p95 is not None else f.forecast)
        pts.append(
            ForecastPoint(
                timestamp=f.date,
                actual=None,
                forecast=float(f.forecast),
                p05=p05,
                p95=p95,
            )
        )

    run_id = str(sr.meta.get("run_id"))
    generated_at = str(sr.meta.get("generated_at", now_iso()))
    return ForecastResponse(run_id=run_id, generated_at=generated_at, series=pts)


# -------------------------------------------------------------------
# DB helpers (inline SQL; matches your db.py style)
# -------------------------------------------------------------------
def _row_to_run(row: sqlite3.Row) -> Run:
    params = RunParams(**json.loads(row["params_json"])) if row["params_json"] else None
    return Run(
        id=row["id"],
        status=row["status"],
        created_at=row["created_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        message=row["message"],
        error=row["error"],
        params=params,
        links=_links_for(row["id"]),
    )


def _get_run_or_404(run_id: str) -> Run:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    return _row_to_run(row)


# -------------------------------------------------------------------
# Routes
# -------------------------------------------------------------------
@router.get("", response_model=List[Run])
def list_runs() -> List[Run]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM runs ORDER BY created_at DESC").fetchall()
    return [_row_to_run(r) for r in rows]


@router.post("", response_model=Run)
def create_run(req: CreateRunRequest) -> Run:
    run_id = uuid4().hex[:12]
    created = now_iso()
    params = _normalize_params(req)
    params_json = json.dumps(params.model_dump(), ensure_ascii=False)

    # Validate data access early so failures are visible as run status.
    # Model-specific load supports both 4-file mode and single-file override.
    try:
        _ = load_daily_weight_series(params.model_key, target_col="sum_weight")
        status: RunStatus = "success"
        message = "Run created (series reproducible)."
        error = None
        finished = created
    except Exception as e:
        status = "failed"
        message = "Run failed."
        error = str(e)
        finished = created

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO runs (id, status, created_at, started_at, finished_at, params_json, message, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (run_id, status, created, created, finished, params_json, message, error),
        )

    return _get_run_or_404(run_id)


@router.get("/{run_id}", response_model=Run)
def get_run(run_id: str) -> Run:
    return _get_run_or_404(run_id)


@router.get("/{run_id}/series", response_model=SeriesResponse)
def get_run_series(run_id: str) -> SeriesResponse:
    run = _get_run_or_404(run_id)
    if run.status == "failed":
        raise HTTPException(status_code=409, detail=f"Run failed: {run.error}")

    # 1) Try materialized artifact first
    with get_conn() as conn:
        row = conn.execute(
            "SELECT series_json FROM run_series WHERE run_id = ?",
            (run_id,),
        ).fetchone()

    if row:
        payload = json.loads(row["series_json"])
        return SeriesResponse(**payload)

    # 2) Not materialized yet -> build and persist (lazy materialization)
    if not run.params:
        raise HTTPException(status_code=400, detail="Run has no params")

    sr = build_series_from_params(run_id, run.params)
    series_json = json.dumps(sr.model_dump(), ensure_ascii=False)
    generated_at = str(sr.meta.get("generated_at", now_iso()))

    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO run_series (run_id, series_json, generated_at) VALUES (?, ?, ?)",
            (run_id, series_json, generated_at),
        )
        conn.execute(
            "UPDATE runs SET status = ?, finished_at = ?, message = ? WHERE id = ?",
            ("success", now_iso(), "Series materialized.", run_id),
        )

    return sr


@router.get("/{run_id}/forecast", response_model=ForecastResponse)
def get_forecast(run_id: str) -> ForecastResponse:
    # Derive legacy contract from stored (or lazily built) series
    sr = get_run_series(run_id)
    return build_legacy_forecast_from_series(sr)


@router.get("/{run_id}/metrics", response_model=MetricsResponse)
def get_run_metrics(run_id: str, backtest_days: int = 56) -> MetricsResponse:
    """
    Simple walk-forward backtest on daily sums:
    forecast(t) = last actual before t
    Metrics:
      - MAPE% (skips days with actual=0)
      - WAPE% (sum|err| / sum(actual))
      - Bias% (sum(err) / sum(actual))
    """
    if backtest_days < 7 or backtest_days > 3650:
        raise HTTPException(status_code=400, detail="backtest_days out of range (7..3650)")

    run = _get_run_or_404(run_id)
    if run.status == "failed":
        raise HTTPException(status_code=409, detail=f"Run failed: {run.error}")
    if not run.params:
        raise HTTPException(status_code=400, detail="Run has no params")

    start = parse_iso_date(run.params.start_date)

    win_to = start - timedelta(days=1)
    win_from = start - timedelta(days=backtest_days)

    daily_df = load_daily_series_for_model(run.params.model_key)
    daily_df["date_dt"] = pd.to_datetime(daily_df["date"])
    daily_df = daily_df.sort_values("date_dt")

    mask = (daily_df["date_dt"].dt.date >= win_from) & (daily_df["date_dt"].dt.date <= win_to)
    window_df = daily_df.loc[mask, ["date_dt", "value"]].copy()

    if window_df.empty:
        return MetricsResponse(
            run_id=run_id,
            model_key=run.params.model_key,
            window={"from": win_from.isoformat(), "to": win_to.isoformat(), "backtest_days": backtest_days},
            metrics={"n": 0, "mape_pct": None, "wape_pct": None, "bias_pct": None},
        )

    hist_mask = daily_df["date_dt"].dt.date < win_from
    hist_df = daily_df.loc[hist_mask, ["date_dt", "value"]]
    prev = float(hist_df["value"].iloc[-1]) if len(hist_df) else 0.0

    abs_pct_errors: List[float] = []
    abs_errors: List[float] = []
    errors: List[float] = []
    sum_actual = 0.0

    for _, r in window_df.iterrows():
        actual = float(r["value"])
        forecast = max(0.0, prev)
        err = forecast - actual

        errors.append(err)
        abs_errors.append(abs(err))
        sum_actual += actual

        if actual != 0:
            abs_pct_errors.append(abs(err) / abs(actual))

        prev = actual

    n = int(len(window_df))
    mape = 100.0 * (sum(abs_pct_errors) / len(abs_pct_errors)) if abs_pct_errors else None
    wape = 100.0 * _safe_div(sum(abs_errors), sum_actual) if sum_actual != 0 else None
    bias = 100.0 * _safe_div(sum(errors), sum_actual) if sum_actual != 0 else None

    return MetricsResponse(
        run_id=run_id,
        model_key=run.params.model_key,
        window={"from": win_from.isoformat(), "to": win_to.isoformat(), "backtest_days": backtest_days},
        metrics={
            "n": n,
            "mape_pct": round(mape, 2) if mape is not None else None,
            "wape_pct": round(wape, 2) if wape is not None else None,
            "bias_pct": round(bias, 2) if bias is not None else None,
        },
    )
