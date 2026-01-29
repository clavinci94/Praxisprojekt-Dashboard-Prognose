# backend/src/app/api/routes/forecast_result.py
from __future__ import annotations

"""Deprecated compatibility router.

Historically there was a separate module persisting forecast results.
The current code derives forecasts via the /runs endpoints (runs.py),
so this module delegates to runs.py for backward compatibility.

Note: Do not include this router together with runs.py in the same FastAPI app,
otherwise the /runs/{run_id}/forecast route will be registered twice.
"""

from fastapi import APIRouter

from app.api.routes.runs import (
    ForecastResponse,
    build_legacy_forecast_from_series,
    get_run_series,
)

router = APIRouter(prefix="/runs", tags=["runs"])


@router.get("/{run_id}/forecast", response_model=ForecastResponse)
def get_run_forecast(run_id: str) -> ForecastResponse:
    sr = get_run_series(run_id)
    return build_legacy_forecast_from_series(sr)
