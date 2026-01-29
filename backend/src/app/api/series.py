from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Optional

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.series_store import SeriesStore

# IMPORTANT:
# - This module defines ONLY its own APIRouter.
# - Do NOT import app.api.router or include_router here (prevents circular imports).
router = APIRouter(prefix="/series", tags=["series"])




store = SeriesStore()


# ---------------------------
# Pydantic models
# ---------------------------
class SeriesRequest(BaseModel):
    start_date: date = Field(..., description="Forecast start date (YYYY-MM-DD)")
    end_date: date = Field(..., description="Forecast end date (YYYY-MM-DD), inclusive")
    history_days: int = Field(
        180, ge=0, le=3650, description="How many days of history to return/use"
    )
    include_quantiles: bool = Field(
        False, description="Include p05/p95 in forecast output"
    )


class ActualPoint(BaseModel):
    date: str = Field(..., description="YYYY-MM-DD")
    actual: float


class ForecastPoint(BaseModel):
    date: str = Field(..., description="YYYY-MM-DD")
    forecast: float
    p05: Optional[float] = None
    p95: Optional[float] = None


class SeriesMetaResponse(BaseModel):
    dataset_key: str
    history_days: int
    start_date: str
    end_date: str

    data_from: str = ""
    data_to: str = ""

    actuals_from: str = ""
    actuals_to: str = ""
    forecast_from: str = ""
    forecast_to: str = ""


class SeriesResponse(BaseModel):
    meta: SeriesMetaResponse
    actuals: List[ActualPoint]
    forecast: List[ForecastPoint]


# ---------------------------
# Helpers
# ---------------------------
def _iso(d) -> str:
    return pd.to_datetime(d).date().isoformat()


def _build_meta(
    dataset_key: str,
    req: SeriesRequest,
    store_meta: Optional[Dict[str, Any]],
    actuals: List[ActualPoint],
    forecast: List[ForecastPoint],
) -> SeriesMetaResponse:
    return SeriesMetaResponse(
        dataset_key=dataset_key,
        history_days=req.history_days,
        start_date=req.start_date.isoformat(),
        end_date=req.end_date.isoformat(),
        data_from=(store_meta or {}).get("data_from", ""),
        data_to=(store_meta or {}).get("data_to", ""),
        actuals_from=actuals[0].date if actuals else "",
        actuals_to=actuals[-1].date if actuals else "",
        forecast_from=forecast[0].date if forecast else "",
        forecast_to=forecast[-1].date if forecast else "",
    )


def _slice_history_daily_utc(
    s: pd.Series, start_date: date, history_days: int
) -> pd.Series:
    """
    History window ends at min(start_date-1, data_to).
    Works even when start_date is in the future (anchors to last available actual).
    """
    if s.empty:
        return s

    s = pd.Series(s).copy()
    s.index = pd.to_datetime(s.index, utc=True)
    s = s.sort_index()

    data_to = s.index.max()

    start_dt = pd.to_datetime(start_date).tz_localize("UTC")
    default_hist_end = start_dt - pd.Timedelta(days=1)
    hist_end = default_hist_end if default_hist_end <= data_to else data_to

    if history_days <= 0:
        hist_start = hist_end
    else:
        hist_start = hist_end - pd.Timedelta(days=history_days - 1)

    return s.loc[(s.index >= hist_start) & (s.index <= hist_end)]


# ---------------------------
# Endpoints
# ---------------------------
@router.get("/datasets")
def list_datasets() -> Dict[str, Any]:
    """
    Returns available datasets that were successfully loaded + metadata (data_from/to, points).
    """
    available = []
    for k, meta in store.available().items():
        available.append(
            {
                "key": k,
                "data_from": meta.data_from,
                "data_to": meta.data_to,
                "points": meta.points,
            }
        )
    return {"available": available}


@router.post("/reload-datasets")
def reload_datasets() -> Dict[str, Any]:
    """
    Forces a reload and returns a verbose report (loaded / missing / empty / failed).
    """
    return store.reload()


@router.post("/series/{dataset_key}", response_model=SeriesResponse)
def get_series(dataset_key: str, req: SeriesRequest) -> SeriesResponse:
    # validate date range
    if req.end_date < req.start_date:
        raise HTTPException(status_code=400, detail="end_date must be >= start_date")

    # load dataset series
    try:
        s = store.get(dataset_key)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset_key}' not available")

    # store meta for response
    meta_obj = store.available().get(dataset_key)
    store_meta = (
        {"data_from": meta_obj.data_from, "data_to": meta_obj.data_to, "points": meta_obj.points}
        if meta_obj
        else None
    )

    # slice history
    hist = _slice_history_daily_utc(s, req.start_date, req.history_days)

    actuals: List[ActualPoint] = []
    if not hist.empty:
        for idx, val in hist.items():
            try:
                fv = float(val)
            except Exception:
                continue
            if pd.isna(fv):
                continue
            actuals.append(ActualPoint(date=_iso(idx), actual=fv))

    # If no history usable -> return 200 with empty arrays
    if not actuals:
        meta = _build_meta(dataset_key, req, store_meta, actuals=[], forecast=[])
        return SeriesResponse(meta=meta, actuals=[], forecast=[])

    # compute horizon
    horizon_days = int((req.end_date - req.start_date).days) + 1
    if horizon_days <= 0:
        meta = _build_meta(dataset_key, req, store_meta, actuals=actuals, forecast=[])
        return SeriesResponse(meta=meta, actuals=actuals, forecast=[])

    # Run forecast using your existing ML core
    # NOTE: This preserves your current architecture: forecast_next_days(...) returns list of dicts:
    #  { "date": ..., "forecast": ..., "p05": ..., "p95": ... }
    try:
        from app.ml.xgb_core import forecast_next_days  # keep as in your current codebase
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Forecast engine import failed: {e}")

    history_y = [p.actual for p in actuals]

    try:
        points = forecast_next_days(
            model_key=dataset_key,
            history_daily_y=history_y,
            start_date=req.start_date.isoformat(),
            horizon_days=horizon_days,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Forecast failed for '{dataset_key}': {e}")

    forecast: List[ForecastPoint] = []
    if points:
        for p in points:
            try:
                d = _iso(p["date"])
                f = float(p["forecast"])
                p05 = float(p["p05"]) if (req.include_quantiles and p.get("p05") is not None) else None
                p95 = float(p["p95"]) if (req.include_quantiles and p.get("p95") is not None) else None
            except Exception:
                continue
            if pd.isna(f):
                continue
            forecast.append(ForecastPoint(date=d, forecast=f, p05=p05, p95=p95))

    meta = _build_meta(dataset_key, req, store_meta, actuals=actuals, forecast=forecast)
    return SeriesResponse(meta=meta, actuals=actuals, forecast=forecast)
