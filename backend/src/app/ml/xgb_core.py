from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Literal, Tuple

import numpy as np
import pandas as pd
import xgboost as xgb

# Assumes this file lives at: backend/src/app/ml/xgb_core.py
PROJECT_ROOT = Path(__file__).resolve().parents[3]
MODELS_DIR = PROJECT_ROOT / "models"

ModelKey = Literal["import", "tra_import", "export", "tra_export"]
QuantileKey = Literal["p50", "p05", "p95"]

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


@lru_cache(maxsize=32)
def load_model(model_key: ModelKey, q: QuantileKey = "p50") -> xgb.Booster:
    path = MODELS_DIR / MODEL_FILES[(model_key, q)]
    if not path.exists():
        raise FileNotFoundError(
            f"XGB model not found for {model_key}/{q}: {path}. "
            f"Run xgb_pipeline.py to generate *_p05.json and *_p95.json."
        )
    booster = xgb.Booster()
    booster.load_model(str(path))
    return booster


@lru_cache(maxsize=8)
def load_feature_list(model_key: ModelKey) -> List[str]:
    path = MODELS_DIR / FEATURE_FILES[model_key]
    if not path.exists():
        raise FileNotFoundError(f"Feature list not found: {path}")
    return json.loads(path.read_text())


def _compute_next_row_features(
    history_y: List[float],  # daily y values; last element = latest known day
    next_date: pd.Timestamp,
    feature_cols: List[str],
) -> Dict[str, float]:
    y = np.array(history_y, dtype=float)
    y = np.clip(y, 0.0, None)
    y_log = np.log1p(y)

    def get_lag(l: int) -> float:
        return float(y_log[-l]) if len(y_log) >= l else float(y_log[0])

    # rollings shifted by 1 => use history up to yesterday
    y_log_hist = y_log[:-1] if len(y_log) > 1 else y_log

    def roll_mean(w: int) -> float:
        tail = y_log_hist[-w:] if len(y_log_hist) >= w else y_log_hist
        return float(np.mean(tail)) if len(tail) else 0.0

    def roll_std(w: int) -> float:
        tail = y_log_hist[-w:] if len(y_log_hist) >= w else y_log_hist
        return float(np.std(tail)) if len(tail) else 0.0

    dow = int(next_date.dayofweek)
    month = int(next_date.month)
    is_weekend = 1 if dow >= 5 else 0

    feats: Dict[str, float] = {
        "dow": float(dow),
        "month": float(month),
        "is_weekend": float(is_weekend),
        "lag_1": get_lag(1),
        "lag_7": get_lag(7),
        "lag_14": get_lag(14),
        "lag_28": get_lag(28),
        "roll_mean_7": roll_mean(7),
        "roll_mean_14": roll_mean(14),
        "roll_mean_28": roll_mean(28),
        "roll_std_7": roll_std(7),
        "roll_std_14": roll_std(14),
        "roll_std_28": roll_std(28),
    }

    return {c: float(feats[c]) for c in feature_cols}


def predict_xgb(model_key: ModelKey, features: List[float] | List[List[float]]) -> List[float]:
    """
    Backward-compatible predictor: returns p50 predictions (original scale, >=0).
    """
    booster = load_model(model_key, "p50")
    feature_cols = load_feature_list(model_key)

    X = np.asarray(features, dtype=float)
    if X.ndim == 1:
        X = X.reshape(1, -1)

    if X.shape[1] != len(feature_cols):
        raise ValueError(
            f"Feature count mismatch: got {X.shape[1]}, expected {len(feature_cols)} for model '{model_key}'."
        )

    dmat = xgb.DMatrix(X, feature_names=feature_cols)
    y_log_pred = booster.predict(dmat)
    y_pred = np.expm1(y_log_pred)
    y_pred = np.clip(y_pred, 0.0, None)
    return y_pred.tolist()


def forecast_next_days(
    model_key: ModelKey,
    history_daily_y: List[float],
    start_date: str,  # ISO date, e.g. "2025-01-01"
    horizon_days: int = 28,
) -> List[Dict[str, float]]:
    """
    Recursive 1-step forecast producing:
      - forecast (p50 point forecast)
      - p05, p95 quantiles
    All on original scale (kg), clipped to >=0, and enforced monotonic band p05<=p50<=p95.
    """
    booster50 = load_model(model_key, "p50")
    booster05 = load_model(model_key, "p05")
    booster95 = load_model(model_key, "p95")
    feature_cols = load_feature_list(model_key)

    hist = [float(max(0.0, v)) for v in history_daily_y]
    current = pd.to_datetime(start_date).normalize()

    out: List[Dict[str, float]] = []

    for _ in range(horizon_days):
        row = _compute_next_row_features(hist, current, feature_cols)
        X = np.array([[row[c] for c in feature_cols]], dtype=float)
        dmat = xgb.DMatrix(X, feature_names=feature_cols)

        y50_log = float(booster50.predict(dmat)[0])
        y05_log = float(booster05.predict(dmat)[0])
        y95_log = float(booster95.predict(dmat)[0])

        y50 = float(np.expm1(y50_log))
        y05 = float(np.expm1(y05_log))
        y95 = float(np.expm1(y95_log))

        # business constraints
        y50 = max(0.0, y50)
        y05 = max(0.0, y05)
        y95 = max(0.0, y95)
        if y05 > y50:
            y05 = y50
        if y95 < y50:
            y95 = y50

        out.append(
            {
                "date": current.date().isoformat(),
                "forecast": y50,
                "p05": y05,
                "p95": y95,
            }
        )

        # recursive feed uses point forecast (p50)
        hist.append(y50)
        current = current + pd.Timedelta(days=1)

    return out
