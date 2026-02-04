from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Literal, Tuple

import numpy as np
import pandas as pd
import xgboost as xgb

ModelKey = Literal["import", "tra_import", "export", "tra_export"]
QuantileKey = Literal["p50", "p05", "p95"]

PROJECT_ROOT = Path(__file__).resolve().parents[3]  # backend/
MODELS_DIR = PROJECT_ROOT / "models"

MODEL_FILES: Dict[Tuple[ModelKey, QuantileKey], str] = {
    ("import", "p50"): "xgb_import.json",
    ("import", "p05"): "xgb_import_p05.json",
    ("import", "p95"): "xgb_import_p95.json",
    ("tra_import", "p50"): "xgb_tra_import.json",
    ("tra_import", "p05"): "xgb_tra_import_p05.json",
    ("tra_import", "p95"): "xgb_tra_import_p95.json",
    ("export", "p50"): "xgb_export.json",
    ("export", "p05"): "xgb_export_p05.json",
    ("export", "p95"): "xgb_export_p95.json",
    ("tra_export", "p50"): "xgb_tra_export.json",
    ("tra_export", "p05"): "xgb_tra_export_p05.json",
    ("tra_export", "p95"): "xgb_tra_export_p95.json",
}

FEATURE_FILES: Dict[ModelKey, str] = {
    "import": "xgb_import_features.json",
    "tra_import": "xgb_tra_import_features.json",
    "export": "xgb_export_features.json",
    "tra_export": "xgb_tra_export_features.json",
}

DEFAULT_FEATURES = [
    "dow",
    "month",
    "is_weekend",
    "lag_1",
    "lag_7",
    "lag_14",
    "lag_28",
    "roll_mean_7",
    "roll_mean_14",
    "roll_mean_28",
    "roll_std_7",
    "roll_std_14",
    "roll_std_28",
]


@lru_cache(maxsize=32)
def load_model(model_key: ModelKey, q: QuantileKey = "p50") -> xgb.Booster:
    path = MODELS_DIR / MODEL_FILES[(model_key, q)]
    if not path.exists():
        if q in ("p05", "p95"):
            # fallback for environments where quantile models are not trained yet
            return load_model(model_key, "p50")
        raise FileNotFoundError(f"Missing XGBoost model for {model_key}/{q}: {path}")
    booster = xgb.Booster()
    booster.load_model(str(path))
    return booster


@lru_cache(maxsize=8)
def load_feature_list(model_key: ModelKey) -> List[str]:
    path = MODELS_DIR / FEATURE_FILES[model_key]
    if not path.exists():
        return DEFAULT_FEATURES
    try:
        cols = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(cols, list) and cols:
            return [str(c) for c in cols]
    except Exception:
        pass
    return DEFAULT_FEATURES


def _feature_row(history_daily_y: List[float], next_date: pd.Timestamp, feature_cols: List[str]) -> Dict[str, float]:
    y = np.asarray([max(0.0, float(v)) for v in history_daily_y], dtype=float)
    if len(y) == 0:
        y = np.asarray([0.0], dtype=float)
    y_log = np.log1p(y)

    def lag(n: int) -> float:
        if len(y_log) >= n:
            return float(y_log[-n])
        return float(y_log[0])

    hist = y_log[:-1] if len(y_log) > 1 else y_log

    def roll_mean(n: int) -> float:
        tail = hist[-n:] if len(hist) >= n else hist
        return float(np.mean(tail)) if len(tail) else 0.0

    def roll_std(n: int) -> float:
        tail = hist[-n:] if len(hist) >= n else hist
        return float(np.std(tail)) if len(tail) else 0.0

    dow = int(next_date.dayofweek)
    month = int(next_date.month)

    base = {
        "dow": float(dow),
        "month": float(month),
        "is_weekend": float(1 if dow >= 5 else 0),
        "lag_1": lag(1),
        "lag_7": lag(7),
        "lag_14": lag(14),
        "lag_28": lag(28),
        "roll_mean_7": roll_mean(7),
        "roll_mean_14": roll_mean(14),
        "roll_mean_28": roll_mean(28),
        "roll_std_7": roll_std(7),
        "roll_std_14": roll_std(14),
        "roll_std_28": roll_std(28),
    }
    return {c: float(base[c]) for c in feature_cols}


def _predict_single(booster: xgb.Booster, feature_cols: List[str], row: Dict[str, float]) -> float:
    X = np.asarray([[row[c] for c in feature_cols]], dtype=float)
    dmat = xgb.DMatrix(X, feature_names=feature_cols)
    y_log = float(booster.predict(dmat)[0])
    return max(0.0, float(np.expm1(y_log)))


def forecast_next_days(
    model_key: ModelKey,
    history_daily_y: List[float],
    start_date: str,
    horizon_days: int = 28,
) -> List[Dict[str, float]]:
    """
    Recursive, dataset-independent forecast for a single flow (import/export/...).
    Target is always daily `sum_weight`.
    """
    if horizon_days <= 0:
        return []

    booster50 = load_model(model_key, "p50")
    booster05 = load_model(model_key, "p05")
    booster95 = load_model(model_key, "p95")
    feature_cols = load_feature_list(model_key)

    hist = [max(0.0, float(v)) for v in history_daily_y]
    if not hist:
        hist = [0.0]

    current_date = pd.to_datetime(start_date).normalize()
    out: List[Dict[str, float]] = []

    for _ in range(horizon_days):
        row = _feature_row(hist, current_date, feature_cols)

        y50 = _predict_single(booster50, feature_cols, row)
        y05 = _predict_single(booster05, feature_cols, row)
        y95 = _predict_single(booster95, feature_cols, row)

        if y05 > y50:
            y05 = y50
        if y95 < y50:
            y95 = y50

        out.append(
            {
                "date": current_date.date().isoformat(),
                "forecast": y50,
                "p05": y05,
                "p95": y95,
            }
        )

        hist.append(y50)  # recursive feed with p50
        current_date = current_date + pd.Timedelta(days=1)

    return out
