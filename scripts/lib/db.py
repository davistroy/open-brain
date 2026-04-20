"""Lightweight Postgres connection helper for Open Brain Python scripts.

Provides a direct psycopg2 connection to the shared Postgres instance.
Used by lab-report-extract.py and any future batch pipelines that write
structured data to Postgres (not SQLite).

Connection string precedence:
  1. DATABASE_URL env var  (e.g. "postgres://openbrain:pass@localhost:5432/open_brain")
  2. config/pipeline.yaml  db.url field
  3. Raises RuntimeError if neither is set

Memory contract: caller is responsible for iterating rows one batch at a
time. This module never materialises full result sets — it just manages
connections and provides an executemany helper.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

log = logging.getLogger("db")

# Lazy import psycopg2 so scripts that don't use DB don't fail at import time
# if the library isn't installed.
try:
    import psycopg2
    import psycopg2.extras
    _PSYCOPG2_AVAILABLE = True
except ImportError:
    _PSYCOPG2_AVAILABLE = False


def _resolve_database_url(cfg: dict | None = None) -> str:
    """Resolve DATABASE_URL from env or config dict.

    Args:
        cfg: Optional pre-loaded config dict (e.g. from pipeline.yaml).
             Expected shape: {"db": {"url": "postgres://..."}}

    Returns:
        Connection string suitable for psycopg2.connect().

    Raises:
        RuntimeError: Neither env var nor config provides a URL.
    """
    url = os.environ.get("DATABASE_URL")
    if url:
        return url

    if cfg:
        db_cfg = cfg.get("db", {})
        url = db_cfg.get("url")
        if url:
            return url

    # Try loading pipeline.yaml from the standard config location
    config_path = Path(__file__).parent.parent.parent / "config" / "pipeline.yaml"
    if config_path.exists():
        try:
            import yaml  # type: ignore[import]
            with config_path.open() as f:
                pipeline_cfg = yaml.safe_load(f) or {}
            url = pipeline_cfg.get("db", {}).get("url")
            if url:
                return url
        except Exception as e:
            log.debug("Could not load pipeline.yaml for DB URL: %s", e)

    raise RuntimeError(
        "DATABASE_URL not set and no db.url in config/pipeline.yaml. "
        "Set DATABASE_URL=postgres://openbrain:<pass>@<host>:5432/open_brain"
    )


def get_connection(cfg: dict | None = None):
    """Open and return a psycopg2 connection.

    The caller is responsible for calling conn.close() (or using it as a
    context manager).  For scripts that open/close once per run, a single
    call to get_connection() is sufficient.

    Args:
        cfg: Optional pre-loaded config dict (see _resolve_database_url).

    Returns:
        psycopg2.extensions.connection

    Raises:
        RuntimeError: psycopg2 is not installed.
        RuntimeError: No DATABASE_URL available.
    """
    if not _PSYCOPG2_AVAILABLE:
        raise RuntimeError(
            "psycopg2-binary is not installed. "
            "Run: pip install -r scripts/requirements-lab.txt"
        )

    url = _resolve_database_url(cfg)
    conn = psycopg2.connect(url)  # type: ignore[possibly-unbound]
    conn.autocommit = False
    log.debug("DB connection opened")
    return conn


def execute_upsert(conn, sql: str, rows: list[tuple[Any, ...]]) -> int:
    """Execute a parameterised INSERT ... ON CONFLICT ... DO NOTHING upsert.

    Streams rows in batches of 500 so memory usage stays bounded regardless
    of how many rows are passed.

    Args:
        conn:  Open psycopg2 connection (autocommit=False assumed).
        sql:   Parameterised INSERT SQL string (use %s placeholders).
        rows:  List of row tuples matching the SQL parameter slots.

    Returns:
        Total number of rows passed to executemany (not count of inserts —
        ON CONFLICT DO NOTHING means actual inserts may be fewer).
    """
    if not rows:
        return 0

    BATCH_SIZE = 500
    total = 0
    with conn.cursor() as cur:
        for i in range(0, len(rows), BATCH_SIZE):
            batch = rows[i : i + BATCH_SIZE]
            psycopg2.extras.execute_batch(cur, sql, batch, page_size=BATCH_SIZE)  # type: ignore[possibly-unbound]
            total += len(batch)
    conn.commit()
    log.debug("execute_upsert: committed %d rows", total)
    return total
