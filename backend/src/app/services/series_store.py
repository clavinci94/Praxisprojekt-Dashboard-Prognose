from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict
import traceback

import pandas as pd

from app.services.datasets import discover_datasets
from app.services.data_loader import load_daily_series_from_csv




@dataclass(frozen=True)
class SeriesMeta:
    data_from: str
    data_to: str
    points: int


class SeriesStore:
    """
    Loads and caches daily time series for all discoverable datasets.
    Provides:
      - available(): meta for loaded datasets
      - get(key): pd.Series (daily, tz-aware UTC index)
      - reload(): reload datasets and returns a verbose report
      - last_reload_report(): last report
    """

    def __init__(self) -> None:
        self._series: Dict[str, pd.Series] = {}
        self._meta: Dict[str, SeriesMeta] = {}
        self._last_reload_report: Dict[str, Any] = {}
        self.reload()

    def reload(self) -> Dict[str, Any]:
        self._series.clear()
        self._meta.clear()

        report: Dict[str, Any] = {
            "loaded": [],
            "skipped_missing_file": [],
            "skipped_empty_series": [],
            "failed": [],
        }

        for ds in discover_datasets():
            if not ds.exists:
                report["skipped_missing_file"].append(
                    {"key": ds.key, "filename": ds.filename, "path": ds.path}
                )
                continue

            path = Path(ds.path)
            try:
                s = load_daily_series_from_csv(path)

                # normalize to pd.Series
                s = pd.Series(s).copy()

                if s.empty or len(s) == 0:
                    report["skipped_empty_series"].append(
                        {"key": ds.key, "filename": ds.filename, "path": ds.path}
                    )
                    continue

                # ensure datetime index, tz-aware UTC
                s.index = pd.to_datetime(s.index, utc=True)
                s = s.sort_index()

                self._series[ds.key] = s
                meta = SeriesMeta(
                    data_from=str(s.index.min().date()),
                    data_to=str(s.index.max().date()),
                    points=int(len(s)),
                )
                self._meta[ds.key] = meta

                report["loaded"].append(
                    {
                        "key": ds.key,
                        "filename": ds.filename,
                        "path": ds.path,
                        "points": meta.points,
                        "data_from": meta.data_from,
                        "data_to": meta.data_to,
                    }
                )

            except Exception as e:
                report["failed"].append(
                    {
                        "key": ds.key,
                        "filename": ds.filename,
                        "path": ds.path,
                        "error": repr(e),
                        "traceback": traceback.format_exc(),
                    }
                )

        self._last_reload_report = report
        return report

    def available(self) -> Dict[str, SeriesMeta]:
        return dict(self._meta)

    def get(self, key: str) -> pd.Series:
        if key not in self._series:
            raise KeyError(f"Dataset not available: {key}")
        return self._series[key]

    def last_reload_report(self) -> Dict[str, Any]:
        return dict(self._last_reload_report)
