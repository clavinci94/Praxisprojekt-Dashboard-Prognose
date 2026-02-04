from __future__ import annotations

import json
import os
from datetime import date as date_type
from datetime import timedelta
from typing import Any, Dict, List, Literal, Optional

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.ml.xgb_core import forecast_next_days
from app.db import get_conn
from app.services.data_loader import load_daily_weight_series

router = APIRouter(prefix="/metrics", tags=["metrics"])

ModelKey = Literal["export", "import", "tra_export", "tra_import"]

DEFAULT_BACKTEST_DAYS = int(os.getenv("CL_BACKTEST_DAYS", "56"))
DEFAULT_HISTORY_DAYS = int(os.getenv("CL_HISTORY_DAYS", "90"))
MIN_APE_DENOMINATOR = 1.0
APE_FLOOR_FRACTION = 0.01


def parse_iso_date(s: str) -> date_type:
    return date_type.fromisoformat(s)


def _safe_div(num: float, den: float) -> float:
    return num / den if den != 0 else 0.0


def _normalize_daily_series(s: pd.Series) -> pd.Series:
    out = pd.Series(s).copy()
    out = pd.to_numeric(out, errors="coerce").fillna(0.0).clip(lower=0.0)
    idx = pd.to_datetime(out.index)
    if isinstance(idx, pd.DatetimeIndex) and idx.tz is not None:
        idx = idx.tz_convert("UTC").tz_localize(None)
    out.index = idx.normalize()
    out = out.sort_index()
    return out


def _ape_floor(actual_values: List[float]) -> float:
    """
    Dynamic floor for APE denominator.
    Prevents meaningless 10,000%+ spikes on near-zero days.
    """
    nonzero = sorted(abs(v) for v in actual_values if abs(v) > 0.0)
    if not nonzero:
        return MIN_APE_DENOMINATOR
    median = nonzero[len(nonzero) // 2]
    return max(MIN_APE_DENOMINATOR, float(median) * APE_FLOOR_FRACTION)


def _compute_ape(abs_error: float, actual: float, denominator_floor: float) -> Optional[float]:
    if abs(actual) < denominator_floor:
        return None
    return abs_error / abs(actual)


def _outlier_score(point: DailyErrorPoint) -> float:
    return float(point.ape) if point.ape is not None else float(point.abs_error)


def _predict_model_backtest(
    model_key: str,
    history_values: List[float],
    date_index: List[pd.Timestamp],
    actual_window: List[float],
) -> tuple[List[float], str, Optional[str]]:
    if not date_index:
        return [], "xgb_walk_forward_1d", None
    if len(date_index) != len(actual_window):
        return [], "naive_persistence_fallback", "date_index and actual_window length mismatch"

    try:
        hist = [max(0.0, float(v)) for v in history_values]
        if not hist:
            hist = [0.0]
        preds: List[float] = []
        for ts, actual in zip(date_index, actual_window):
            pts = forecast_next_days(
                model_key=model_key,  # type: ignore[arg-type]
                history_daily_y=hist,
                start_date=ts.date().isoformat(),
                horizon_days=1,
            )
            if not pts:
                raise ValueError("empty forecast output")
            pred = max(0.0, float(pts[0].get("forecast", 0.0)))
            preds.append(pred)
            # walk-forward: next day forecast sees the actual observed demand
            hist.append(max(0.0, float(actual)))
        return preds, "xgb_walk_forward_1d", None
    except Exception as e:
        return [], "naive_persistence_fallback", repr(e)


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
    error: float
    abs_error: float
    ape: Optional[float] = None


class MetricsResponse(BaseModel):
    run_id: Optional[str] = None
    model_key: str
    window: Dict[str, Any]
    metrics: Dict[str, Any]
    daily_errors: List[DailyErrorPoint]


def compute_naive_backtest_metrics(
    *,
    model_key: str,
    start_date: date_type,
    series: pd.Series,
    backtest_days: int,
    include_daily_errors: bool,
    daily_errors_limit: int,
    outliers_only: bool,
) -> MetricsResponse:
    """
    Backtest metrics against historical actuals.
    Uses recursive model forecast first; falls back to naive persistence if needed.
    """
    daily = _normalize_daily_series(series)

    if daily.empty:
        return MetricsResponse(
            run_id=None,
            model_key=model_key,
            window={"from": None, "to": None, "backtest_days": backtest_days},
            metrics={"n": 0, "mape_pct": None, "wape_pct": None, "bias_pct": None},
            daily_errors=[],
        )

    requested_to = start_date - timedelta(days=1)
    max_available = daily.index.max().date()
    win_to = min(requested_to, max_available)
    win_from = win_to - timedelta(days=max(1, backtest_days) - 1)

    if win_to < win_from:
        return MetricsResponse(
            run_id=None,
            model_key=model_key,
            window={"from": win_from.isoformat(), "to": win_to.isoformat(), "backtest_days": backtest_days},
            metrics={"n": 0, "mape_pct": None, "wape_pct": None, "bias_pct": None},
            daily_errors=[],
        )

    idx = pd.date_range(win_from, win_to, freq="D")
    window = daily.reindex(idx, fill_value=0.0)
    hist = daily[daily.index < idx[0]]
    history_values = [float(v) for v in hist.values]
    model_forecasts, method, method_error = _predict_model_backtest(
        model_key=model_key,
        history_values=history_values,
        date_index=list(idx),
        actual_window=[float(v) for v in window.values],
    )
    if not model_forecasts:
        model_forecasts = []
        prev = float(history_values[-1]) if history_values else 0.0
        for value in window.values:
            model_forecasts.append(max(0.0, prev))
            prev = float(value)

    abs_pct_errors: List[float] = []
    smape_terms: List[float] = []
    abs_errors: List[float] = []
    errors: List[float] = []
    sum_actual = 0.0
    daily_errors: List[DailyErrorPoint] = []
    actual_values = [float(v) for v in window.values]
    ape_floor = _ape_floor(actual_values)
    zero_actual_days = 0

    for ts, value, forecast in zip(idx, window.values, model_forecasts):
        actual = float(value)
        forecast = max(0.0, float(forecast))
        err = forecast - actual
        ae = abs(err)
        if actual == 0.0:
            zero_actual_days += 1
        ape = _compute_ape(ae, actual, ape_floor)
        smape_den = abs(actual) + abs(forecast)
        smape = (2.0 * ae / smape_den) if smape_den > 0 else None

        errors.append(err)
        abs_errors.append(ae)
        sum_actual += actual
        if ape is not None:
            abs_pct_errors.append(ape)
        if smape is not None:
            smape_terms.append(smape)

        if include_daily_errors:
            daily_errors.append(
                DailyErrorPoint(
                    date=ts.date().isoformat(),
                    actual=actual,
                    forecast=forecast,
                    error=err,
                    abs_error=ae,
                    ape=ape,
                )
            )

    if include_daily_errors:
        if outliers_only:
            daily_errors = sorted(
                daily_errors,
                key=lambda p: (-_outlier_score(p), -float(p.abs_error), p.date),
            )[: max(1, daily_errors_limit)]
        else:
            daily_errors = daily_errors[-max(1, daily_errors_limit) :]
    else:
        daily_errors = []

    n = int(len(window))
    mape = 100.0 * (sum(abs_pct_errors) / len(abs_pct_errors)) if abs_pct_errors else None
    smape = 100.0 * (sum(smape_terms) / len(smape_terms)) if smape_terms else None
    wape = 100.0 * _safe_div(sum(abs_errors), sum_actual) if sum_actual != 0 else None
    bias = 100.0 * _safe_div(sum(errors), sum_actual) if sum_actual != 0 else None

    return MetricsResponse(
        run_id=None,
        model_key=model_key,
        window={"from": win_from.isoformat(), "to": win_to.isoformat(), "backtest_days": backtest_days},
        metrics={
            "n": n,
            "method": method,
            "method_error": method_error,
            "nonzero_actual_days": n - zero_actual_days,
            "zero_actual_days": zero_actual_days,
            "ape_denominator_floor": round(ape_floor, 2),
            "mape_pct": round(mape, 2) if mape is not None else None,
            "smape_pct": round(smape, 2) if smape is not None else None,
            "wape_pct": round(wape, 2) if wape is not None else None,
            "bias_pct": round(bias, 2) if bias is not None else None,
        },
        daily_errors=daily_errors,
    )


@router.post("/{model_key}", response_model=MetricsResponse)
def metrics_live(
    model_key: ModelKey,
    req: MetricsRequest,
    include_daily_errors: bool = False,
    daily_errors_limit: int = 120,
    outliers_only: bool = False,
) -> MetricsResponse:
    start = parse_iso_date(req.start_date)
    try:
        series = load_daily_weight_series(model_key, target_col="sum_weight")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load data for '{model_key}': {e}")

    return compute_naive_backtest_metrics(
        model_key=model_key,
        start_date=start,
        series=series,
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
    with get_conn() as conn:
        row = conn.execute("SELECT params_json FROM runs WHERE id = ?", (run_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")

    try:
        params = json.loads(row["params_json"] or "{}")
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to decode run params")

    model_key = str(params.get("model_key") or "export").strip().lower()
    start_raw = str(params.get("start_date") or "")
    if model_key not in {"export", "import", "tra_export", "tra_import"}:
        raise HTTPException(status_code=400, detail=f"Unsupported model_key in run: {model_key}")
    if not start_raw:
        raise HTTPException(status_code=400, detail="Run has no start_date in params")

    try:
        start_date = parse_iso_date(start_raw)
    except Exception:
        raise HTTPException(status_code=400, detail=f"Invalid run start_date: {start_raw}")

    try:
        series = load_daily_weight_series(model_key, target_col="sum_weight")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load data for run: {e}")

    res = compute_naive_backtest_metrics(
        model_key=model_key,
        start_date=start_date,
        series=series,
        backtest_days=backtest_days,
        include_daily_errors=include_daily_errors,
        daily_errors_limit=daily_errors_limit,
        outliers_only=outliers_only,
    )
    res.run_id = run_id
    return res
