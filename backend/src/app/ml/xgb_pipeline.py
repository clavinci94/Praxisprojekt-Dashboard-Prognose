from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

# === Pfade ===
PROJECT_ROOT = Path(__file__).resolve().parents[3]  # backend/
MODELS_DIR = PROJECT_ROOT / "models"

CARGOLOGIC_DATA_DIR="/Users/claudio/Desktop/Projekt Cargologic"


# === 4 Jobs ===
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

# === Feature Engineering Settings ===
LAGS = [1, 7, 14, 28]
ROLLS = [7, 14, 28]


def _load_daily_weight(csv_path: Path, time_col: str) -> pd.Series:
    """
    Aggregiert daily Summe(weight_sum) (fallback: awb_weight),
    füllt fehlende Tage mit 0.
    """
    usecols = [time_col, "weight_sum", "awb_weight"]
    df = pd.read_csv(csv_path, usecols=lambda c: c in usecols)

    df[time_col] = pd.to_datetime(df[time_col], errors="coerce")
    df = df.dropna(subset=[time_col])

    # weight_sum bevorzugt, fallback awb_weight
    w = pd.to_numeric(df.get("weight_sum"), errors="coerce")
    if w.isna().all():
        w = pd.to_numeric(df.get("awb_weight"), errors="coerce")
    else:
        w2 = pd.to_numeric(df.get("awb_weight"), errors="coerce")
        w = w.fillna(w2)

    w = w.fillna(0.0)
    df["_w"] = w.clip(lower=0.0)

    daily = df.groupby(df[time_col].dt.floor("D"))["_w"].sum().sort_index()

    # Lücken füllen
    full_idx = pd.date_range(daily.index.min(), daily.index.max(), freq="D")
    daily = daily.reindex(full_idx, fill_value=0.0)
    return daily.astype(float)


def _make_features(daily: pd.Series) -> Tuple[pd.DataFrame, List[str]]:
    """
    1-step-ahead supervised features:
    y(t) wird aus Features von t-1, t-7, ... vorhergesagt.
    """
    s = daily.copy()
    df = pd.DataFrame({"date": s.index, "y": s.values})
    df["y_log"] = np.log1p(df["y"].clip(lower=0.0))

    # Kalenderfeatures
    df["dow"] = df["date"].dt.dayofweek.astype(int)
    df["month"] = df["date"].dt.month.astype(int)
    df["is_weekend"] = (df["dow"] >= 5).astype(int)

    # Lags + Rolling auf log-scale
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
    # zentraler Param-Satz für Konsistenz
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
    Requires xgboost version that supports objective 'reg:quantileerror'.
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

    out: Dict[str, Path] = {}

    for job in JOBS:
        csv_path = DATA_DIR / job.csv_name
        if not csv_path.exists():
            raise FileNotFoundError(f"CSV not found: {csv_path}")

        daily = _load_daily_weight(csv_path, job.time_col)
        df_feat, feature_cols = _make_features(daily)

        # Save feature order once (shared for p50/p05/p95)
        feat_path = MODELS_DIR / job.model_file.replace(".json", "_features.json")
        feat_path.write_text(pd.Series(feature_cols).to_json(orient="values"))

        # --- Train models ---
        m50 = _train_point(df_feat, feature_cols)
        m05 = _train_quantile(df_feat, feature_cols, 0.05)
        m95 = _train_quantile(df_feat, feature_cols, 0.95)

        base_path = MODELS_DIR / job.model_file
        p05_path = MODELS_DIR / job.model_file.replace(".json", "_p05.json")
        p95_path = MODELS_DIR / job.model_file.replace(".json", "_p95.json")

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
