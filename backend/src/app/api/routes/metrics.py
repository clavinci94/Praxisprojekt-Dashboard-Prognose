from __future__ import annotations

import json
import os
from datetime import date as date_type
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.db import get_conn


router = APIRouter(prefix="/metrics", tags=["metrics"])


# -----------------------------
# Config (same assumptions as runs.py)
# -----------------------------
DEFAULT_DATA_DIR = Path(
    os.getenv(
        "CARGOLOGIC_DATA_DIR",
        os.getenv("CL_DATA_DIR", str(Path.home() / "Desktop" / "Projekt Cargologic")),
    )
).expanduser()

REQUIRED_FILES = [
    "cl_export.csv",
    "cl_import.csv",
    "cl_tra_export.csv",
    "cl_tra_import.csv",
]
REQUIRED_FILES = list(dict.fromkeys(REQUIRED_FILES))

DATE_COL = os.getenv("CL_DATE_COL", "fl_gmt_departure_date")
VALUE_COL = os.getenv("CL_VALUE_COL", "weight_sum")

DEFAULT_BACKTEST_DAYS = int(os.getenv("CL_BACKTEST_DAYS", "56"))
DEFAULT_HISTORY_DAYS = int(os.getenv("CL_HISTORY_DAYS", "90"))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso_date(s: str) -> date_type:
    return date_type.fromisoformat(s)


def _safe_div(num: float, den: float) -> float:
    return num / den if den != 0 else 0.0


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


# -----------------------------
# API Models
# -----------------------------
ModelKey = Literal["export", "import", "tra_export", "tra_import"]


class MetricsRequest(BaseModel):
    start_date: str = Field(..., description="YYYY-MM-DD")
    history_days: int = Field(default=DEFAULT_HISTORY_DAYS, ge=1, le=3650)
    backtest_days: int = Field(default=DEFAULT_BACKTEST_DAYS, ge=7, le=3650)

    @field_validator("start_date")
    @classmethod
    def _validate_start_date(cls, v: str) -> str:
        parse_iso_date(v)
        return v


class DailyErrorPoint(BaseModel):
    date: str
    actual: float
    forecast: float
    error: float       # forecast - actual
    abs_error: float
    ape: Optional[float] = None  # abs(error)/abs(actual) if actual!=0


class MetricsResponse(BaseModel):
    # one of these identifiers will be set
    run_id: Optional[str] = None
    model_key: str

    window: Dict[str, Any]
    metrics: Dict[str, Any]
    daily_errors: List[DailyErrorPoint]


def compute_naive_backtest_metrics(
    *,
    model_key: str,
    start_date: date_type,
    backtest_days: int,
    include_daily_errors: bool,
    daily_errors_limit: int,
    outliers_only: bool,
) -> MetricsResponse:

    """
    Walk-forward naive baseline:
    forecast(t) = last actual before t
    """
    daily_df = load_daily_series_from_csvs()
    daily_df["date_dt"] = pd.to_datetime(daily_df["date"])
    daily_df = daily_df.sort_values("date_dt")

    win_to = start_date - timedelta(days=1)
    win_from = start_date - timedelta(days=backtest_days)

    mask = (daily_df["date_dt"].dt.date >= win_from) & (daily_df["date_dt"].dt.date <= win_to)
    window_df = daily_df.loc[mask, ["date_dt", "value"]].copy()

    if window_df.empty:
        return MetricsResponse(
            run_id=None,
            model_key=model_key,
            window={"from": win_from.isoformat(), "to": win_to.isoformat(), "backtest_days": backtest_days},
            metrics={"n": 0, "mape_pct": None, "wape_pct": None, "bias_pct": None},
            daily_errors=[],
        )

    hist_mask = daily_df["date_dt"].dt.date < win_from
    hist_df = daily_df.loc[hist_mask, ["date_dt", "value"]]
    prev = float(hist_df["value"].iloc[-1]) if len(hist_df) else 0.0

    abs_pct_errors: List[float] = []
    abs_errors: List[float] = []
    errors: List[float] = []
    sum_actual = 0.0
    daily_errors: List[DailyErrorPoint] = []

    # ... in der Schleife ...
    if include_daily_errors:
        daily_errors.append(
            DailyErrorPoint(
                date=dt,
                actual=actual,
                forecast=forecast,
                error=err,
                abs_error=ae,
                ape=ape,
            )
        )

        if include_daily_errors:
            # optional: nur Top Outliers
            if outliers_only:
                def score(x: DailyErrorPoint) -> float:
                    return float(x.ape) if x.ape is not None else float(x.abs_error)

                daily_errors = sorted(daily_errors, key=score, reverse=True)[:daily_errors_limit]
            else:
                # “letzte N Tage” (stabil & für Charts sinnvoll)
                daily_errors = daily_errors[-daily_errors_limit:]
        else:
            daily_errors = []

    n = int(len(window_df))
    mape = 100.0 * (sum(abs_pct_errors) / len(abs_pct_errors)) if abs_pct_errors else None
    wape = 100.0 * _safe_div(sum(abs_errors), sum_actual) if sum_actual != 0 else None
    bias = 100.0 * _safe_div(sum(errors), sum_actual) if sum_actual != 0 else None

    return MetricsResponse(
        run_id=None,
        model_key=model_key,
        window={"from": win_from.isoformat(), "to": win_to.isoformat(), "backtest_days": backtest_days},
        metrics={
            "n": n,
            "mape_pct": round(mape, 2) if mape is not None else None,
            "wape_pct": round(wape, 2) if wape is not None else None,
            "bias_pct": round(bias, 2) if bias is not None else None,
        },
        daily_errors=daily_errors,
    )


# -----------------------------
# Routes
# -----------------------------
@router.post("/{model_key}", response_model=MetricsResponse)
def metrics_live(
    model_key: ModelKey,
    req: MetricsRequest,
    include_daily_errors: bool = False,
    daily_errors_limit: int = 120,
    outliers_only: bool = False,
) -> MetricsResponse:
    start = parse_iso_date(req.start_date)
    return compute_naive_backtest_metrics(
        model_key=model_key,
        start_date=start,
        backtest_days=req.backtest_days,
        include_daily_errors=include_daily_errors,
        daily_errors_limit=daily_errors_limit,
        outliers_only=outliers_only,
    )



@router.get("/runs/{run_id}", response_model=MetricsResponse)
def metrics_for_run(
    run_id: str,
    backtest_days: int = DEFAULT_BACKTEST_DAYS,
    include_daily_errors: bool = False,
    daily_errors_limit: int = 120,
    outliers_only: bool = False,
) -> MetricsResponse:
    # ... run laden ...
    res = compute_naive_backtest_metrics(
        model_key=model_key,
        start_date=start_date,
        backtest_days=backtest_days,
        include_daily_errors=include_daily_errors,
        daily_errors_limit=daily_errors_limit,
        outliers_only=outliers_only,
    )
    res.run_id = run_id
    return res

