from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Dict, List


@dataclass(frozen=True)
class DatasetSpec:
    key: str
    filename: str
    time_col: str


@dataclass(frozen=True)
class DatasetInfo:
    key: str
    filename: str
    time_col: str
    path: str
    exists: bool


DATASETS: Dict[str, DatasetSpec] = {
    # eingehende Sendungen -> Arrival-Zeit
    "import": DatasetSpec("import", "cl_import.csv", "fl_gmt_arrival_date"),
    "tra_import": DatasetSpec("tra_import", "cl_tra_import.csv", "fl_gmt_arrival_date"),
    # ausgehende Sendungen -> Departure-Zeit
    "export": DatasetSpec("export", "cl_export.csv", "fl_gmt_departure_date"),
    "tra_export": DatasetSpec("tra_export", "cl_tra_export.csv", "fl_gmt_departure_date"),
}


def _single_csv_override() -> Path | None:
    raw = _get_setting("CARGOLOGIC_CSV_FILE", "CL_CSV_FILE")
    if not raw:
        return None
    p = Path(raw).expanduser()
    return p if p.is_file() else None


def _infer_key_from_filename(filename: str) -> str:
    name = filename.lower()
    if "tra_import" in name:
        return "tra_import"
    if "tra_export" in name:
        return "tra_export"
    if "import" in name:
        return "import"
    return "export"


def _time_col_for_key(key: str) -> str:
    return "fl_gmt_arrival_date" if "import" in key else "fl_gmt_departure_date"


@lru_cache(maxsize=1)
def _read_local_env() -> Dict[str, str]:
    env_path = Path(__file__).resolve().parents[3] / ".env"  # backend/.env
    if not env_path.exists():
        return {}

    out: Dict[str, str] = {}
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            out[key] = value
    return out


def _get_setting(*keys: str) -> str | None:
    for key in keys:
        val = os.getenv(key)
        if val:
            return val
    local = _read_local_env()
    for key in keys:
        val = local.get(key)
        if val:
            return val
    return None


def get_data_dir() -> Path:
    """
    Returns the directory containing CargoLogic CSV files.

    Priority:
    1) CARGOLOGIC_DATA_DIR
    2) CL_DATA_DIR
    3) ~/Desktop/Projekt Cargologic
    """
    p = _get_setting("CARGOLOGIC_DATA_DIR", "CL_DATA_DIR")
    if p:
        return Path(p).expanduser()
    return Path.home() / "Desktop" / "Projekt Cargologic"


def resolve_dataset(dataset_key: str) -> DatasetSpec:
    key = (dataset_key or "").strip().lower()
    if key not in DATASETS:
        raise KeyError(f"Unknown dataset_key: {dataset_key}")
    return DATASETS[key]


def resolve_dataset_path(dataset_key: str) -> Path:
    single = _single_csv_override()
    if single is not None:
        return single
    spec = resolve_dataset(dataset_key)
    return get_data_dir() / spec.filename


def discover_datasets() -> List[DatasetInfo]:
    single = _single_csv_override()
    if single is not None:
        key = _infer_key_from_filename(single.name)
        return [
            DatasetInfo(
                key=key,
                filename=single.name,
                time_col=_time_col_for_key(key),
                path=str(single),
                exists=True,
            )
        ]

    data_dir = get_data_dir()
    out: List[DatasetInfo] = []
    for spec in DATASETS.values():
        fpath = data_dir / spec.filename
        out.append(
            DatasetInfo(
                key=spec.key,
                filename=spec.filename,
                time_col=spec.time_col,
                path=str(fpath),
                exists=fpath.exists() and fpath.is_file(),
            )
        )
    return out
