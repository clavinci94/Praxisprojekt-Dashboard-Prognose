from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List
import os

DATASET_FILES: Dict[str, str] = {
    "export": "cl_export.csv",
    "import": "cl_import.csv",
    "tra_export": "cl_tra_export.csv",
    "tra_import": "cl_tra_import.csv",
}


@dataclass(frozen=True)
class DatasetInfo:
    key: str
    filename: str
    path: str
    exists: bool


def get_data_dir() -> Path:
    """Return directory that contains the CargoLogic CSV files.

    Priority:
    1) env var CARGOLOGIC_DATA_DIR
    2) fallback to app.ml.xgb_pipeline.DATA_DIR if present (dev convenience)
    """
    p = os.getenv("CARGOLOGIC_DATA_DIR")
    if p:
        return Path(p).expanduser()

    # Dev fallback: reuse training pipeline's DATA_DIR if available.
    try:
        from app.ml.xgb_pipeline import DATA_DIR  # type: ignore
        return Path(DATA_DIR).expanduser()
    except Exception as e:
        raise RuntimeError(
            "CARGOLOGIC_DATA_DIR is not set and xgb_pipeline.DATA_DIR fallback not available"
        ) from e


def discover_datasets() -> List[DatasetInfo]:
    data_dir = get_data_dir()
    out: List[DatasetInfo] = []
    for key, fname in DATASET_FILES.items():
        fpath = data_dir / fname
        out.append(
            DatasetInfo(
                key=key,
                filename=fname,
                path=str(fpath),
                exists=fpath.exists() and fpath.is_file(),
            )
        )
    return out


def resolve_dataset_path(dataset_key: str) -> Path:
    if dataset_key not in DATASET_FILES:
        raise KeyError(f"Unknown dataset_key: {dataset_key}")
    return get_data_dir() / DATASET_FILES[dataset_key]
