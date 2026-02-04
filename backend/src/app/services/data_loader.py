from __future__ import annotations

from pathlib import Path
from typing import Optional, Union

import pandas as pd

from app.services.datasets import resolve_dataset, resolve_dataset_path

TARGET_COLS = ["sum_weight", "weight_sum", "awb_weight", "am_weight"]
TIME_COL_CANDIDATES = [
    "fl_gmt_arrival_date",
    "fl_gmt_departure_date",
    "am_action_date",
]
DEFAULT_TIME_COL = "am_action_date"


def _resolve_target_column(df: pd.DataFrame, preferred: str = "sum_weight") -> str:
    if preferred in df.columns:
        return preferred
    for col in TARGET_COLS:
        if col in df.columns:
            return col
    raise ValueError(f"Missing target column. Expected one of {TARGET_COLS}.")


def _resolve_time_column(df: pd.DataFrame, preferred: str) -> str:
    candidates = [preferred, DEFAULT_TIME_COL, *TIME_COL_CANDIDATES]
    for col in dict.fromkeys(candidates):
        if col in df.columns:
            return col
    raise ValueError(f"Missing time column. Expected one of {list(dict.fromkeys(candidates))}.")


def load_daily_series_from_csv(csv_path: Path, time_col: str, target_col: str = "sum_weight") -> pd.Series:
    wanted_cols = list(dict.fromkeys([time_col, target_col, DEFAULT_TIME_COL, *TIME_COL_CANDIDATES, *TARGET_COLS]))
    df = pd.read_csv(
        csv_path,
        sep=",",
        usecols=lambda c: c in wanted_cols,
        low_memory=False,
        on_bad_lines="skip",
    )

    resolved_time_col = _resolve_time_column(df, time_col)

    value_col = _resolve_target_column(df, preferred=target_col)

    # UTC-aware parsing
    dt = pd.to_datetime(df[resolved_time_col], errors="coerce", utc=True)
    df = df.assign(_dt=dt).dropna(subset=["_dt"])

    # Zielwert = sum_weight (Fallback auf kompatible Spalten)
    y = pd.to_numeric(df[value_col], errors="coerce").fillna(0.0).clip(lower=0.0)

    daily = (
        pd.DataFrame({"dt": df["_dt"], "y": y})
        .assign(day=lambda x: x["dt"].dt.floor("D"))
        .groupby("day")["y"]
        .sum()
        .sort_index()
    )

    if daily.empty:
        return pd.Series(dtype=float, name="sum_weight")

    # Lücken als 0 auffüllen, damit Features konsistent sind
    full_idx = pd.date_range(daily.index.min(), daily.index.max(), freq="D", tz="UTC")
    daily = daily.reindex(full_idx, fill_value=0.0)
    daily.name = "sum_weight"
    return daily.astype(float)


def load_daily_weight_series(
    dataset_key_or_path: Union[str, Path],
    *,
    dataset_key: Optional[str] = None,
    time_col: Optional[str] = None,
    target_col: str = "sum_weight",
) -> pd.Series:
    """
    Loads a daily series by dataset key (export/import/...) or explicit CSV path.

    Independent per dataset, shared target semantics (`sum_weight`).
    """
    if isinstance(dataset_key_or_path, Path):
        csv_path = dataset_key_or_path
        resolved_time_col = time_col or DEFAULT_TIME_COL
        return load_daily_series_from_csv(csv_path, resolved_time_col, target_col=target_col)

    raw = str(dataset_key_or_path)
    maybe_path = Path(raw)
    if maybe_path.exists() and maybe_path.is_file():
        resolved_time_col = time_col or DEFAULT_TIME_COL
        return load_daily_series_from_csv(maybe_path, resolved_time_col, target_col=target_col)

    # otherwise treat input as dataset key
    key = (dataset_key or raw).strip().lower()
    spec = resolve_dataset(key)
    csv_path = resolve_dataset_path(key)
    return load_daily_series_from_csv(csv_path, spec.time_col, target_col=target_col)
