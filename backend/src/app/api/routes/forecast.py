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
    raw = model_key
    key = (model_key or "").strip().lower()

    # optional: akzeptiere alte Prefixe wie xgb_export / model_export / forecast_export
    for prefix in ("xgb_", "model_", "forecast_"):
        if key.startswith(prefix):
            key = key[len(prefix) :]

    if key not in ALLOWED_MODELS:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown model_key: {raw} (normalized: {key}). Allowed: {sorted(ALLOWED_MODELS)}",
        )
    return key


class ForecastRequest(BaseModel):
    start_date: date
    horizon_days: int = Field(gt=0, le=90)


class ForecastPoint(BaseModel):
    date: str
    forecast: float


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
    model_key = normalize_model_key(model_key)

    try:
        series = load_daily_weight_series(model_key)  # pd.Series mit DatetimeIndex
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load data: {e}")

    if series is None or len(series) == 0:
        raise HTTPException(status_code=500, detail="Loaded empty time series")

    # timezone normalisieren
    if isinstance(series.index, pd.DatetimeIndex) and series.index.tz is not None:
        series.index = series.index.tz_convert(None)

    if not isinstance(series.index, pd.DatetimeIndex):
        raise HTTPException(status_code=500, detail="Time series index is not DatetimeIndex")

    out: List[ActualPoint] = []
    for ts, val in series.items():
        out.append(ActualPoint(date=ts.date().isoformat(), value=float(val)))

    return out


@router.post("/forecast/{model_key}", response_model=ForecastResponse)
def forecast_endpoint(model_key: str, req: ForecastRequest):
    model_key = normalize_model_key(model_key)

    try:
        series = load_daily_weight_series(model_key)  # daily pd.Series
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load data: {e}")

    if series is None or len(series) == 0:
        raise HTTPException(status_code=500, detail="Loaded empty time series")

    # timezone normalisieren
    if isinstance(series.index, pd.DatetimeIndex) and series.index.tz is not None:
        series.index = series.index.tz_convert(None)

    if not isinstance(series.index, pd.DatetimeIndex):
        raise HTTPException(status_code=500, detail="Time series index is not DatetimeIndex")

    start_ts = pd.to_datetime(req.start_date).normalize()
    if start_ts <= series.index.min():
        raise HTTPException(
            status_code=400,
            detail=(
                "start_date must be after first available date "
                f"({series.index.min().date().isoformat()})"
            ),
        )

    # History bis VORTAG von start_date
    hist_series = series.loc[series.index < start_ts]
    if len(hist_series) == 0:
        raise HTTPException(status_code=400, detail="Not enough history before start_date")

    history_daily_y = [float(v) for v in hist_series.tolist()]

    # start_date immer als ISO-String
    start_date_str = req.start_date.isoformat() if hasattr(req.start_date, "isoformat") else str(req.start_date)

    yhat = forecast_next_days(
        model_key=model_key,
        history_daily_y=history_daily_y,
        start_date=start_date_str,
        horizon_days=req.horizon_days,
    )

    # yhat ist List[Dict[str, float]]
    forecast_points: list[ForecastPoint] = []
    for row in yhat:
        date_str = row.get("date") or row.get("ds") or row.get("timestamp")

        val = row.get("forecast")
        if val is None:
            val = row.get("yhat")
        if val is None:
            val = row.get("value")

        if date_str is None or val is None:
            raise HTTPException(status_code=500, detail=f"Unexpected forecast row shape: {row}")

        forecast_points.append(
            ForecastPoint(
                date=str(date_str)[:10],
                forecast=float(val),
            )
        )
    return ForecastResponse(
        model=model_key,
        start_date=start_date_str,
        horizon_days=req.horizon_days,
        forecast=forecast_points,
    )
