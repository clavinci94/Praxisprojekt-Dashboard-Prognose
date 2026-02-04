from __future__ import annotations

import traceback
from typing import Any, Dict, List

from fastapi import APIRouter, FastAPI
from fastapi.responses import PlainTextResponse
from starlette.requests import Request

from app.api.router import router as api_router
from app.services.datasets import discover_datasets

app = FastAPI(title="forecast")


@app.exception_handler(Exception)
async def all_exception_handler(request: Request, exc: Exception):
    return PlainTextResponse(
        "EXCEPTION:\n"
        + "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
        status_code=500,
    )


datasets_router = APIRouter()


@datasets_router.get("/datasets")
def get_datasets() -> Dict[str, List[Dict[str, Any]]]:
    try:
        return {"available": [d.__dict__ for d in discover_datasets() if d.exists]}
    except Exception:
        # Keep frontend operable even if discovery fails temporarily.
        return {
            "available": [
                {"key": "export", "filename": "cl_export.csv", "time_col": "fl_gmt_departure_date", "path": "", "exists": False},
                {"key": "import", "filename": "cl_import.csv", "time_col": "fl_gmt_arrival_date", "path": "", "exists": False},
                {"key": "tra_export", "filename": "cl_tra_export.csv", "time_col": "fl_gmt_departure_date", "path": "", "exists": False},
                {"key": "tra_import", "filename": "cl_tra_import.csv", "time_col": "fl_gmt_arrival_date", "path": "", "exists": False},
            ]
        }


app.include_router(api_router)
app.include_router(datasets_router, prefix="/api")
