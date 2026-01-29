from __future__ import annotations

from pathlib import Path
from typing import Union
import pandas as pd

from app.services.datasets import resolve_dataset_path

WEIGHT_COLS = ["weight_sum", "awb_weight", "am_weight"]


def load_daily_series_from_csv(csv_path: Path) -> pd.Series:
    df = pd.read_csv(
        csv_path,
        sep=",",
        low_memory=False,
    )

    if "am_action_date" not in df.columns:
        raise ValueError(f"Missing column am_action_date in {csv_path.name}")

    # weight column wählen
    weight_col = next((c for c in WEIGHT_COLS if c in df.columns), None)
    if weight_col is None:
        raise ValueError(
            f"Missing weight column. Expected one of {WEIGHT_COLS} in {csv_path.name}"
        )

    # Date parsing -> UTC-aware
    dt = pd.to_datetime(df["am_action_date"], errors="coerce", utc=True)
    df = df.assign(_dt=dt).dropna(subset=["_dt"])

    # Gewichte numeric
    w = pd.to_numeric(df[weight_col], errors="coerce").fillna(0)

    # Tagesaggregation
    df_day = (
        pd.DataFrame({"dt": df["_dt"], "w": w})
        .assign(day=lambda x: x["dt"].dt.floor("D"))
        .groupby("day")["w"]
        .sum()
        .sort_index()
    )

    df_day.index = df_day.index.tz_convert("UTC")  # konsistent
    df_day.name = "weight"
    return df_day


def load_daily_weight_series(dataset_key_or_path: Union[str, Path]) -> pd.Series:
    """Load daily series by dataset key (export/import/...) or explicit CSV path.

    Fix: forecast called load_daily_weight_series("export") and the loader tried
    to open a file literally named "export".
    """
    # If caller passed a Path or a string path that exists -> use it directly.
    if isinstance(dataset_key_or_path, Path):
        csv_path = dataset_key_or_path
    else:
        s = str(dataset_key_or_path)
        p = Path(s)
        if p.exists() and p.is_file():
            csv_path = p
        else:
            # Treat as dataset key
            csv_path = resolve_dataset_path(s)

    return load_daily_series_from_csv(csv_path)
