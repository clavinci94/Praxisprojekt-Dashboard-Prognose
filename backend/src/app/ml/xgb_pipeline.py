from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

from app.services.data_loader import load_daily_weight_series
from app.services.datasets import DATASETS

PROJECT_ROOT = Path(__file__).resolve().parents[3]  # backend/
MODELS_DIR = PROJECT_ROOT / "models"

LAGS = [1, 7, 14, 28]
ROLLS = [7, 14, 28]


def _model_file_stem(dataset_key: str) -> str:
    return f"xgb_{dataset_key}"


def _base_params() -> Dict[str, float | int]:
    return {
        "n_estimators": 700,
        "learning_rate": 0.05,
        "max_depth": 6,
        "subsample": 0.9,
        "colsample_bytree": 0.9,
        "reg_lambda": 1.0,
        "random_state": 42,
        "n_jobs": -1,
    }


def _build_feature_frame(daily_sum_weight: pd.Series) -> Tuple[pd.DataFrame, List[str]]:
    df = pd.DataFrame({"date": pd.to_datetime(daily_sum_weight.index), "y": daily_sum_weight.values})
    df["y"] = pd.to_numeric(df["y"], errors="coerce").fillna(0.0).clip(lower=0.0)
    df["y_log"] = np.log1p(df["y"])

    df["dow"] = df["date"].dt.dayofweek.astype(int)
    df["month"] = df["date"].dt.month.astype(int)
    df["is_weekend"] = (df["dow"] >= 5).astype(int)

    for lag in LAGS:
        df[f"lag_{lag}"] = df["y_log"].shift(lag)

    for w in ROLLS:
        shifted = df["y_log"].shift(1)
        df[f"roll_mean_{w}"] = shifted.rolling(w).mean()
        df[f"roll_std_{w}"] = shifted.rolling(w).std()

    feature_cols = (
        ["dow", "month", "is_weekend"]
        + [f"lag_{lag}" for lag in LAGS]
        + [f"roll_mean_{w}" for w in ROLLS]
        + [f"roll_std_{w}" for w in ROLLS]
    )
    df = df.dropna().reset_index(drop=True)
    return df, feature_cols


def _fit_point(df_feat: pd.DataFrame, feature_cols: List[str]) -> XGBRegressor:
    X = df_feat[feature_cols].to_numpy(dtype=float)
    y = df_feat["y_log"].to_numpy(dtype=float)
    model = XGBRegressor(objective="reg:squarederror", **_base_params())
    model.fit(X, y)
    return model


def _fit_quantile(df_feat: pd.DataFrame, feature_cols: List[str], alpha: float) -> XGBRegressor:
    X = df_feat[feature_cols].to_numpy(dtype=float)
    y = df_feat["y_log"].to_numpy(dtype=float)
    try:
        model = XGBRegressor(
            objective="reg:quantileerror",
            quantile_alpha=float(alpha),
            **_base_params(),
        )
        model.fit(X, y)
        return model
    except Exception:
        # Fallback for older xgboost versions without quantile objective.
        model = XGBRegressor(objective="reg:squarederror", **_base_params())
        model.fit(X, y)
        return model


def train_and_save_all() -> Dict[str, Path]:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    saved: Dict[str, Path] = {}

    for dataset_key in DATASETS.keys():
        daily = load_daily_weight_series(dataset_key, target_col="sum_weight")
        df_feat, feature_cols = _build_feature_frame(daily)
        if df_feat.empty:
            raise ValueError(f"Not enough history to train dataset '{dataset_key}'.")

        stem = _model_file_stem(dataset_key)
        base_path = MODELS_DIR / f"{stem}.json"
        p05_path = MODELS_DIR / f"{stem}_p05.json"
        p95_path = MODELS_DIR / f"{stem}_p95.json"
        features_path = MODELS_DIR / f"{stem}_features.json"

        m50 = _fit_point(df_feat, feature_cols)
        m05 = _fit_quantile(df_feat, feature_cols, 0.05)
        m95 = _fit_quantile(df_feat, feature_cols, 0.95)

        m50.get_booster().save_model(str(base_path))
        m05.get_booster().save_model(str(p05_path))
        m95.get_booster().save_model(str(p95_path))
        features_path.write_text(json.dumps(feature_cols), encoding="utf-8")

        saved[f"{dataset_key}:p50"] = base_path
        saved[f"{dataset_key}:p05"] = p05_path
        saved[f"{dataset_key}:p95"] = p95_path

    return saved


if __name__ == "__main__":
    result = train_and_save_all()
    print("Saved models:")
    for key, path in result.items():
        print(f"  {key} -> {path}")
