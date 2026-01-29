# backend/src/app/main.py
from __future__ import annotations

import traceback
from typing import Any, Dict, List

from fastapi import APIRouter, FastAPI
from fastapi.responses import PlainTextResponse
from starlette.requests import Request

from app.services.datasets import discover_datasets
from app.api.router import router as api_router

app = FastAPI(title="forecast")


# --- DEV: Exception handler (returns traceback as plain text) ---
@app.exception_handler(Exception)
async def all_exception_handler(request: Request, exc: Exception):
    return PlainTextResponse(
        "EXCEPTION:\n"
        + "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
        status_code=500,
    )


# --- Datasets API (used by the UI dropdown) ---
datasets_router = APIRouter()


@datasets_router.get("/datasets")
def get_datasets() -> List[Dict[str, Any]]:
    # discover_datasets() returns DatasetInfo dataclasses
    return [d.__dict__ for d in discover_datasets()]


# --- Routes ---
# Keep the single /api prefix here (avoid /api/api)
app.include_router(datasets_router, prefix="/api")

# Main API router (already prefixed with /api inside)
app.include_router(api_router)
