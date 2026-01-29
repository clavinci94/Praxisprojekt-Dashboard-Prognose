from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

# ============================================================
# Paths / Config
# ============================================================

def _guess_project_root(here: Path) -> Path:
    """
    Best-effort project root detection.

    Walk upwards and pick the first directory that looks like the backend root
    (contains 'models' or 'pyproject.toml' or 'requirements.txt'). Fallback to
    3 levels up to preserve the previous behaviour.
    """
    for p in [here, *here.parents]:
        if (p / "models").exists() or (p / "pyproject.toml").exists() or (p / "requirements.txt").exists():
            return p
    # previous heuristic (may be wrong depending on where this file lives)
    return here.parents[3]


HERE = Path(__file__).resolve()
PROJECT_ROOT = _guess_project_root(HERE)
MODELS_DIR = PROJECT_ROOT / "models"

# Data directory:
# - Prefer env var CARGOLOGIC_DATA_DIR
# - Otherwise default to '<PROJECT_ROOT>/data'
DATA_DIR = Path(os.environ.get("CARGOLOGIC_DATA_DIR", str(PROJECT_ROOT / "data"))).expanduser().resolve()

# ============================================================
# Jobs
# ============================================================

@dataclass(frozen=True)
class Job:
    key: str
    csv_name: str
    time_col: str
    model_file: str  # base/p50 file, e.g. xgb_import.json


JOBS: List[Job] = [
    Job("import", "cl_import.csv", "fl_gmt_arrival_date", "xgb_import.json"),
    Job("tra_import", "cl_tra_import.csv", "fl_gmt_arrival_date", "xgb_tra_import.json"),
    Job("export", "cl_export.csv", "fl_gmt_departure_date", "xgb_export.json"),
    Job("tra_export", "cl_tra_export.csv", "fl_gmt_departure_date", "xgb_tra_export.json"),
]

# ============================================================
# Feature engineering settings
# ============================================================

LAGS = [1, 7, 14, 28]
ROLLS = [7, 14, 28]


def _load_daily_weight(csv_path: Path, time_col: str) -> pd.Series:
    """
    Aggregate to daily sum of weight.

    Tries 'weight_sum' first, falls back to 'awb_weight'. Missing days are filled with 0.
    """
    usecols = [time_col, "weight_sum", "awb_weight"]
    df = pd.read_csv(csv_path, usecols=lambda c: c in usecols)

    df[time_col] = pd.to_datetime(df[time_col], errors="coerce")
    df = df.dropna(subset=[time_col])

    # Prefer weight_sum, fall back to awb_weight
    w = pd.to_numeric(df.get("weight_sum"), errors="coerce")
    if w.isna().all():
        w = pd.to_numeric(df.get("awb_weight"), errors="coerce")
    else:
        w2 = pd.to_numeric(df.get("awb_weight"), errors="coerce")
        w = w.fillna(w2)

    w = w.fillna(0.0)
    df["_w"] = w.clip(lower=0.0)

    daily = df.groupby(df[time_col].dt.floor("D"))["_w"].sum().sort_index()

    # Fill gaps
    if daily.empty:
        raise ValueError(f"No valid rows found in {csv_path} for time_col='{time_col}'")

    full_idx = pd.date_range(daily.index.min(), daily.index.max(), freq="D")
    daily = daily.reindex(full_idx, fill_value=0.0)
    return daily.astype(float)


def _make_features(daily: pd.Series) -> Tuple[pd.DataFrame, List[str]]:
    """
    1-step-ahead supervised features in log-space.

    Target: y_log(t)
    Features: calendar + lags/rolling computed on past values only.
    """
    s = daily.copy()
    df = pd.DataFrame({"date": s.index, "y": s.values})
    df["y_log"] = np.log1p(df["y"].clip(lower=0.0))

    # Calendar
    df["dow"] = df["date"].dt.dayofweek.astype(int)
    df["month"] = df["date"].dt.month.astype(int)
    df["is_weekend"] = (df["dow"] >= 5).astype(int)

    # Lags + rolling on log-scale (shift to avoid leakage)
    for lag in LAGS:
        df[f"lag_{lag}"] = df["y_log"].shift(lag)

    for w in ROLLS:
        df[f"roll_mean_{w}"] = df["y_log"].shift(1).rolling(w).mean()
        df[f"roll_std_{w}"] = df["y_log"].shift(1).rolling(w).std()

    feature_cols = (
        ["dow", "month", "is_weekend"]
        + [f"lag_{lag}" for lag in LAGS]
        + [f"roll_mean_{w}" for w in ROLLS]
        + [f"roll_std_{w}" for w in ROLLS]
    )

    df = df.dropna().reset_index(drop=True)
    return df, feature_cols


def _base_model_params() -> dict:
    # Central param set for consistent training
    return dict(
        n_estimators=800,
        learning_rate=0.05,
        max_depth=6,
        subsample=0.9,
        colsample_bytree=0.9,
        reg_lambda=1.0,
        random_state=42,
        n_jobs=-1,
    )


def _train_point(df_feat: pd.DataFrame, feature_cols: List[str]) -> XGBRegressor:
    X = df_feat[feature_cols].to_numpy(dtype=float)
    y = df_feat["y_log"].to_numpy(dtype=float)

    model = XGBRegressor(objective="reg:squarederror", **_base_model_params())
    model.fit(X, y)
    return model


def _train_quantile(df_feat: pd.DataFrame, feature_cols: List[str], alpha: float) -> XGBRegressor:
    """
    Quantile regression (log-space).

    Note: requires an xgboost version that supports objective 'reg:quantileerror'.
    If your installed xgboost doesn't support it, training will raise.
    """
    X = df_feat[feature_cols].to_numpy(dtype=float)
    y = df_feat["y_log"].to_numpy(dtype=float)

    model = XGBRegressor(
        objective="reg:quantileerror",
        quantile_alpha=float(alpha),
        **_base_model_params(),
    )
    model.fit(X, y)
    return model


def train_and_save_all() -> Dict[str, Path]:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    if not DATA_DIR.exists():
        raise FileNotFoundError(
            f"DATA_DIR does not exist: {DATA_DIR}\n"
            f"Set env var CARGOLOGIC_DATA_DIR or create a 'data' folder under {PROJECT_ROOT}."
        )

    out: Dict[str, Path] = {}

    for job in JOBS:
        csv_path = DATA_DIR / job.csv_name
        if not csv_path.exists():
            raise FileNotFoundError(f"CSV not found: {csv_path}")

        daily = _load_daily_weight(csv_path, job.time_col)
        df_feat, feature_cols = _make_features(daily)

        # Save feature order once (shared for p50/p05/p95)
        feat_path = MODELS_DIR / job.model_file.replace(".json", "_features.json")
        feat_path.write_text(json.dumps(feature_cols, ensure_ascii=False, indent=2), encoding="utf-8")

        # --- Train models ---
        m50 = _train_point(df_feat, feature_cols)
        m05 = _train_quantile(df_feat, feature_cols, 0.05)
        m95 = _train_quantile(df_feat, feature_cols, 0.95)

        base_path = MODELS_DIR / job.model_file
        p05_path = MODELS_DIR / job.model_file.replace(".json", "_p05.json")
        p95_path = MODELS_DIR / job.model_file.replace(".json", "_p95.json")

        # Note: despite '.json' extension, these are xgboost booster model files.
        m50.get_booster().save_model(str(base_path))
        m05.get_booster().save_model(str(p05_path))
        m95.get_booster().save_model(str(p95_path))

        out[f"{job.key}:p50"] = base_path
        out[f"{job.key}:p05"] = p05_path
        out[f"{job.key}:p95"] = p95_path

    return out


if __name__ == "__main__":
    paths = train_and_save_all()
    print("✅ Saved models:")
    for k, p in paths.items():
        print(f"  {k}: {p}")
