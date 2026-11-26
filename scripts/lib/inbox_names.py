"""Inbox filename helpers shared by the ingest sidecar pipelines (item 9.4).

core-api's ``POST /api/v1/ingest/upload`` writes each uploaded file into the
sidecar inbox as ``<uploadId>-<original name>`` (``uploadId`` is a UUID). The
prefix keeps two uploads of the same export from colliding and ties the file
to its ``file_uploads`` row, but the pipelines route on the ORIGINAL export
name (``activity.csv``, ``HSA*.csv``, ``Download.csv`` …). Every name-based
routing decision must therefore look at :func:`strip_upload_prefix` of the
basename, while moves and logs keep using the real on-disk name.

Pure stdlib.
"""

from __future__ import annotations

import re

_UPLOAD_PREFIX_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-",
    re.IGNORECASE,
)


def strip_upload_prefix(name: str) -> str:
    """Return ``name`` without one leading ``<uuid>-`` upload prefix.

    Names without the prefix are returned unchanged.
    """
    return _UPLOAD_PREFIX_RE.sub("", name, count=1)
