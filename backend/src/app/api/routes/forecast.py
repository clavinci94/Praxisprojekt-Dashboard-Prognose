from __future__ import annotations

from datetime import date
from typing import List

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.ml.xgb_core import forecast_next_days
from app.services.data_loader import load_daily_weight_series

router = APIRouter(tags=["forecast"])

ALLOWED_MODELS = {"export", "import", "tra_export", "tra_import"}


def normalize_model_key(model_key: str) -> str:
    key = (model_key or "").strip().lower()
    for prefix in ("xgb_", "model_", "forecast_"):
        if key.startswith(prefix):
            key = key[len(prefix) :]
    if key not in ALLOWED_MODELS:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown model_key: {model_key}. Allowed: {sorted(ALLOWED_MODELS)}",
        )
    return key


class ForecastRequest(BaseModel):
    start_date: date
    horizon_days: int = Field(gt=0, le=90)


class ForecastPoint(BaseModel):
    date: str
    forecast: float
    p05: float | None = None
    p95: float | None = None


class ForecastResponse(BaseModel):
    model: str
    start_date: str
    horizon_days: int
    forecast: List[ForecastPoint]


class ActualPoint(BaseModel):
    date: str
    value: float


@router.get("/actuals/{model_key}", response_model=List[ActualPoint])
def actuals_endpoint(model_key: str):
    key = normalize_model_key(model_key)
    try:
        series = load_daily_weight_series(key, target_col="sum_weight")
    except Exception as e:
        # keep legacy fallback endpoint non-fatal for frontend
        return []

    if series.empty:
        return []

    idx = pd.to_datetime(series.index)
    if isinstance(idx, pd.DatetimeIndex) and idx.tz is not None:
        idx = idx.tz_convert("UTC").tz_localize(None)

    return [ActualPoint(date=d.date().isoformat(), value=float(v)) for d, v in zip(idx, series.values)]


@router.post("/forecast/{model_key}", response_model=ForecastResponse)
def forecast_endpoint(model_key: str, req: ForecastRequest):
    key = normalize_model_key(model_key)

    try:
        series = load_daily_weight_series(key, target_col="sum_weight")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load data: {e}")

    if series.empty:
        raise HTTPException(status_code=400, detail=f"No data available for '{key}'.")

    start_ts = pd.to_datetime(req.start_date).normalize()
    series_index = pd.to_datetime(series.index)
    if isinstance(series_index, pd.DatetimeIndex) and series_index.tz is not None:
        series_index = series_index.tz_convert("UTC").tz_localize(None)

    hist_mask = series_index < start_ts
    history = [float(v) for v in series.values[hist_mask]]

    if not history:
        first_date = series_index.min().date().isoformat()
        raise HTTPException(
            status_code=400,
            detail=f"Not enough history before start_date. First available date: {first_date}",
        )

    points = forecast_next_days(
        model_key=key,  # type: ignore[arg-type]
        history_daily_y=history,
        start_date=req.start_date.isoformat(),
        horizon_days=req.horizon_days,
    )

    return ForecastResponse(
        model=key,
        start_date=req.start_date.isoformat(),
        horizon_days=req.horizon_days,
        forecast=[ForecastPoint(**p) for p in points],
    )
