"""YAML-driven ingest router for the Python sidecar (CS3.12).

Reads ``config/ingest-routes.yaml`` — the shared source-of-truth consumed by
both the TypeScript upload endpoint (``packages/core-api/src/services/
ingest-router.ts`` — CS3.11) and this Python helper — so the TS and Python
sides never drift on which filename maps to which pipeline + parser.

YAML shape (as seeded in CS2.9)::

    routes:
      financial:
        - pattern: "activity.csv"
          parser:  amex
        - pattern: "Download*.csv"
          parser:  paypal
          header_sniff: '"Balance Impact"'
      utility:
        - pattern: "*gas*.pdf"
          parser:  gas_bill

Each ``source_type`` (``financial`` / ``utility`` / future) maps to an
ordered list of ``{pattern, parser, header_sniff?}`` rules. ``pattern`` is
a glob (matched with ``fnmatch`` against the basename, case-insensitive),
not a regex. First match wins. ``header_sniff`` is advisory here — the
pipeline scripts themselves do the actual CSV header probing to
disambiguate generic filenames (e.g. PayPal "Download.csv").

The pipeline script filename is derived from the source_type by
convention: ``{source_type}-pipeline.py`` (sits next to this module in
``scripts/``). This keeps the YAML declarative (no script paths baked in)
while letting ``trigger_server.py`` resolve a source_type → absolute
path at runtime.

Public API
----------

* ``load_routes(config_path=None)`` — parse + cache the YAML.
* ``route_for_source(source_type)`` — return the routing block for a
  source_type (list of rules).
* ``route_for_filename(filename)`` — return the first rule matching a
  filename, with ``source_type`` / ``pipeline`` / ``parser`` populated.
* ``script_for_source(source_type)`` — return the pipeline script name
  (e.g. ``financial-pipeline.py``). This is the hook
  ``docker/ingest-sidecar/trigger_server.py`` imports.
* ``resolve_command_args(route, file_path, extra_args=None)`` — build the
  subprocess argv for running the pipeline against a single file.
* ``list_source_types()`` — sorted source_type list (for diagnostics).

All functions are safe to call from any process; the YAML is loaded once
per process and memoized in a module-level cache. Call
``_clear_cache()`` (private) from tests that need a fresh load.
"""

from __future__ import annotations

import fnmatch
import json
import os
import sys
from pathlib import Path
from typing import Any

try:
    import yaml  # PyYAML
except ImportError as _yaml_exc:  # pragma: no cover — hard dep
    yaml = None  # type: ignore[assignment]
    _YAML_IMPORT_ERROR: Exception | None = _yaml_exc
else:
    _YAML_IMPORT_ERROR = None


# ---------------------------------------------------------------------------
# Defaults + module-level cache
# ---------------------------------------------------------------------------

DEFAULT_CONTAINER_PATH = "/app/config/ingest-routes.yaml"
DEFAULT_REPO_PATH = "config/ingest-routes.yaml"

_cache: dict[str, Any] | None = None
_cache_source: str | None = None


def _resolve_config_path(config_path: str | Path | None) -> Path:
    """Resolve the YAML path with env-var + fallback support.

    Precedence:
      1. Explicit ``config_path`` argument.
      2. ``$INGEST_ROUTES_PATH`` env var.
      3. ``/app/config/ingest-routes.yaml`` (container default).
      4. ``./config/ingest-routes.yaml`` relative to cwd (repo default).
    """
    if config_path is not None:
        return Path(config_path)
    env = os.environ.get("INGEST_ROUTES_PATH")
    if env:
        return Path(env)
    container = Path(DEFAULT_CONTAINER_PATH)
    if container.exists():
        return container
    return Path(DEFAULT_REPO_PATH)


def _clear_cache() -> None:
    """Reset the module cache — intended for tests."""
    global _cache, _cache_source
    _cache = None
    _cache_source = None


def load_routes(config_path: str | Path | None = None) -> dict[str, Any]:
    """Load + parse ``ingest-routes.yaml`` and cache the result.

    Returns the full parsed YAML document. Raises ``FileNotFoundError`` if
    the file is missing and ``RuntimeError`` if PyYAML isn't installed.
    """
    global _cache, _cache_source

    if yaml is None:  # pragma: no cover — hard dep
        raise RuntimeError(
            "PyYAML is required for ingest_router but is not installed. "
            f"Original import error: {_YAML_IMPORT_ERROR!r}"
        )

    path = _resolve_config_path(config_path)
    key = str(path.resolve()) if path.exists() else str(path)

    if _cache is not None and _cache_source == key:
        return _cache

    if not path.exists():
        raise FileNotFoundError(f"ingest-routes.yaml not found at {path!s}")

    with path.open("r", encoding="utf-8") as fh:
        parsed = yaml.safe_load(fh) or {}

    if not isinstance(parsed, dict):
        raise ValueError(
            f"ingest-routes.yaml must be a mapping at top level, got {type(parsed).__name__}"
        )

    _cache = parsed
    _cache_source = key
    return parsed


# ---------------------------------------------------------------------------
# Source-type / pipeline helpers
# ---------------------------------------------------------------------------


def list_source_types(config_path: str | Path | None = None) -> list[str]:
    """Return the sorted list of known source types."""
    routes = load_routes(config_path).get("routes") or {}
    if not isinstance(routes, dict):
        return []
    return sorted(routes.keys())


def route_for_source(
    source_type: str,
    config_path: str | Path | None = None,
) -> list[dict[str, Any]] | None:
    """Return the routing-rule list for ``source_type`` (or ``None``)."""
    routes = load_routes(config_path).get("routes") or {}
    if not isinstance(routes, dict):
        return None
    rules = routes.get(source_type)
    if rules is None:
        return None
    if not isinstance(rules, list):
        return None
    # Defensive copy so callers can't mutate the cache.
    return [dict(r) for r in rules if isinstance(r, dict)]


def script_for_source(
    source_type: str,
    config_path: str | Path | None = None,
) -> str | None:
    """Return the pipeline script filename for ``source_type``.

    By convention: ``{source_type}-pipeline.py``. Returns ``None`` for
    unknown source types. This is the function
    ``docker/ingest-sidecar/trigger_server.py`` imports to resolve a
    source_type into an executable script — keep the name stable.
    """
    if not source_type:
        return None
    # Only acknowledge source types that actually appear in the YAML so we
    # don't silently fabricate pipeline names for typos.
    known = list_source_types(config_path)
    if source_type not in known:
        return None
    return f"{source_type}-pipeline.py"


# ---------------------------------------------------------------------------
# Filename → route dispatch
# ---------------------------------------------------------------------------


def route_for_filename(
    filename: str,
    config_path: str | Path | None = None,
) -> dict[str, Any] | None:
    """Return the first route matching ``filename``, or ``None``.

    Matching:
      * Glob-style via ``fnmatch`` against the basename.
      * Case-insensitive — both the pattern and filename are lowercased.
      * Iterates source types in sorted order, then rules in declaration
        order within each source type. First hit wins.

    The returned dict is a flattened view of the rule plus its
    source_type and the derived pipeline script::

        {
          "source_type":  "financial",
          "pipeline":     "financial-pipeline.py",
          "parser":       "amex",
          "pattern":      "activity.csv",
          "header_sniff": None,  # or the literal string from YAML
        }
    """
    if not filename:
        return None

    basename = os.path.basename(filename).lower()
    routes = load_routes(config_path).get("routes") or {}
    if not isinstance(routes, dict):
        return None

    for source_type in sorted(routes.keys()):
        rules = routes.get(source_type) or []
        if not isinstance(rules, list):
            continue
        for rule in rules:
            if not isinstance(rule, dict):
                continue
            pattern = str(rule.get("pattern", ""))
            if not pattern:
                continue
            if fnmatch.fnmatchcase(basename, pattern.lower()):
                return {
                    "source_type": source_type,
                    "pipeline": f"{source_type}-pipeline.py",
                    "parser": rule.get("parser"),
                    "pattern": pattern,
                    "header_sniff": rule.get("header_sniff"),
                }
    return None


# ---------------------------------------------------------------------------
# Subprocess argv helper
# ---------------------------------------------------------------------------


def resolve_command_args(
    route: dict[str, Any],
    file_path: str,
    extra_args: list[str] | None = None,
) -> list[str]:
    """Build the subprocess argv for running a pipeline against one file.

    Mirrors the invocation pattern in ``trigger_server.run_pipeline`` so
    callers wanting to dispatch a single file (not an inbox sweep) get a
    consistent command shape::

        python scripts/<pipeline> --process-inbox --file <path> --json-output [extra...]

    ``sys.executable`` is used over the bare string ``"python"`` so the
    same invocation works inside the sidecar (python3.12) and on the
    host (wherever ``python`` resolves).
    """
    if not isinstance(route, dict):
        raise TypeError("route must be a dict returned by route_for_filename")
    pipeline = route.get("pipeline")
    if not pipeline:
        raise ValueError("route is missing 'pipeline'")

    argv: list[str] = [
        sys.executable or "python",
        f"scripts/{pipeline}",
        "--process-inbox",
        "--file",
        str(file_path),
        "--json-output",
    ]
    if extra_args:
        argv.extend(extra_args)
    return argv


# ---------------------------------------------------------------------------
# CLI entrypoint — ``python -m scripts.lib.ingest_router --list``
# ---------------------------------------------------------------------------


def _main(argv: list[str]) -> int:  # pragma: no cover — CLI shim
    if "--list" in argv or "-l" in argv:
        out = {
            "source_types": list_source_types(),
            "routes": load_routes().get("routes", {}),
        }
        print(json.dumps(out, indent=2, sort_keys=True))
        return 0
    if "--match" in argv:
        i = argv.index("--match")
        if i + 1 >= len(argv):
            print("usage: --match <filename>", file=sys.stderr)
            return 2
        match = route_for_filename(argv[i + 1])
        print(json.dumps(match, indent=2, sort_keys=True))
        return 0
    print(
        "ingest_router — YAML-driven routing helper\n"
        "usage:\n"
        "  python -m scripts.lib.ingest_router --list\n"
        "  python -m scripts.lib.ingest_router --match <filename>",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main(sys.argv[1:]))
