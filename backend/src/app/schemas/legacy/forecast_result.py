# app/api/forecast_results.py
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from typing import Any, Dict

from ..db.forecast_results import get_forecast_result, upsert_forecast_result

router = APIRouter(tags=["runs"])

@router.get("/runs/{run_id}/forecast")
def get_run_forecast(run_id: str) -> Dict[str, Any]:
    payload = get_forecast_result(run_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="No forecast result stored for this run_id.")
    return payload

# Optional (für Worker): Ergebnis speichern via API
@router.put("/runs/{run_id}/forecast")
def put_run_forecast(run_id: str, payload: Dict[str, Any]) -> Dict[str, str]:
    upsert_forecast_result(run_id, payload)
    return {"status": "ok"}
