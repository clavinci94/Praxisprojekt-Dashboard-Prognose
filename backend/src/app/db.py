from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional


def _default_db_path() -> Path:
    # Prefer explicit env var; otherwise keep under ./data for easy persistence
    p = os.getenv("CL_RUNS_DB_PATH") or os.getenv("CARGOLOGIC_RUNS_DB_PATH") or "./data/runs.db"
    return Path(p).expanduser()


DB_PATH: Path = _default_db_path()


def init_db(db_path: Optional[Path] = None) -> None:
    path = (db_path or DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
              id TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              started_at TEXT,
              finished_at TEXT,
              params_json TEXT NOT NULL,
              message TEXT,
              error TEXT
            );
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS run_series (
              run_id TEXT PRIMARY KEY,
              series_json TEXT NOT NULL,
              generated_at TEXT NOT NULL,
              FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
            );
            """
        )

        conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);")


@contextmanager
def get_conn(db_path: Optional[Path] = None) -> Iterator[sqlite3.Connection]:
    path = (db_path or DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.row_factory = sqlite3.Row
        yield conn
        conn.commit()
    finally:
        conn.close()
