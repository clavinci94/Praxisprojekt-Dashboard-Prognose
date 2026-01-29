from fastapi import APIRouter

from app.api.routes.health import router as health_router
from app.api.routes.version import router as version_router
from app.api.routes.runs import router as runs_router
from app.api.routes.forecast import router as forecast_router
from app.api.series import router as series_router

router = APIRouter(prefix="/api")

router.include_router(health_router)
router.include_router(version_router)
router.include_router(runs_router)
router.include_router(forecast_router)
router.include_router(series_router)

