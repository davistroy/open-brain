"""HTTP trigger server for the Open Brain ingest sidecar (CS3.7).

Replaces the legacy `sleep infinity` + host-cron `docker exec` invocation model
with an HTTP-triggered service that core-api's `ingest-process` BullMQ job
POSTs to after a user uploads a file through the dashboard.

Design constraints
------------------
* Pure Python stdlib — no Flask/FastAPI/aiohttp. The container is on an
  internal Docker network and doesn't need a real web framework.
* Threading HTTP server + per-request handler, but a single-slot file lock
  (``/tmp/process.lock``) serializes pipeline invocations so two concurrent
  uploads don't corrupt the shared SQLite DB.
* Auth: ``X-Open-Brain-Caller: ingest`` + ``Authorization: Bearer <secret>``
  where the secret comes from ``INGEST_TRIGGER_SECRET``. Constant-time comparison.
* Source binding: each sidecar container is bound to exactly one pipeline
  via the ``INGEST_SOURCE`` env var (``financial`` or ``utility``). The body
  may override with ``{"source": "..."}`` when the ingest_router says so,
  but the default is the container's bound source.
* Subprocess timeout: ``TRIGGER_TIMEOUT_SEC`` (default 300s).
* Graceful shutdown on SIGTERM/SIGINT so Docker's 10s grace period suffices.

Endpoints
---------
* ``GET  /healthz`` → ``200 {"status": "ok"}`` — no auth, Docker healthcheck.
* ``GET  /health``  → ``200 {"status":"idle"}`` or ``409 {"status":"busy"}``
  depending on whether the process lock is held (spec CS3.7).
* ``POST /process`` → runs the bound pipeline with ``--process-inbox
  --json-output`` and returns ``{status, captures_posted, errors,
  duration_ms, exit_code, stderr}``. Auth required.
* ``POST /trigger/{source}`` → generic variant. Uses ingest_router if
  available, otherwise falls back to hardcoded ``financial`` / ``utility``
  dispatch. Auth required.

The final line of stdout from the pipeline is expected to be a JSON summary
(CS3.9 contract: ``{captures_posted: [...], errors: [...], duration_ms: N}``).
If stdout doesn't end with parseable JSON, we still return 200 but with
``status: "ok"`` and ``captures_posted: []`` plus the raw stderr — the
BullMQ job can decide how strict to be.

Testability
-----------
Config is read lazily via ``Config.from_env()``; ``create_app(config)`` is a
factory returning a ``ThreadingHTTPServer`` bound to a handler class closed
over the config. Tests can instantiate a handler directly with an in-memory
config, mock ``run_pipeline``, and assert HTTP contract without touching
``os.environ`` or spawning real processes.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:  # fcntl is Unix-only; tests on Windows substitute a stub via sys.modules
    import fcntl as _fcntl
except ImportError:  # pragma: no cover — production container is Linux
    _fcntl = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Config:
    """Immutable runtime config for the trigger server.

    Read once at startup from ``os.environ`` via ``Config.from_env()``. All
    handlers and helpers receive a ``Config`` instance rather than reading
    module-level globals — this keeps tests hermetic.
    """

    port: int = 8080
    bind_host: str = "0.0.0.0"
    ingest_trigger_secret: str = ""
    ingest_source: str = "financial"
    trigger_timeout_sec: int = 300
    lock_path: str = "/tmp/process.lock"
    app_dir: Path = field(default_factory=lambda: Path("/app"))
    # Known pipelines bound to this sidecar image. The ingest_router (CS3.12)
    # will eventually own this mapping; we keep a hardcoded fallback so CS3.7
    # doesn't hard-depend on a parallel subagent's output.
    fallback_pipelines: dict[str, str] = field(
        default_factory=lambda: {
            "financial": "financial-pipeline.py",
            "utility": "utility-pipeline.py",
        }
    )
    # Optional ingest_router module for CS3.12 source→script mapping. Wired
    # at factory time so tests can stub it.
    ingest_router: Any = None

    @classmethod
    def from_env(cls, environ: dict[str, str] | None = None) -> "Config":
        """Read config from ``environ`` (defaults to ``os.environ``).

        No required-field validation here — ``main()`` emits warnings for the
        two soft-invalid states (``INGEST_TRIGGER_SECRET`` empty, unknown
        ``INGEST_SOURCE``) rather than crashing, preserving the pre-refactor
        behavior. Callers that want hard validation can subclass or wrap.
        """
        env = environ if environ is not None else os.environ
        app_dir = Path(env.get("APP_DIR", "/app"))
        return cls(
            port=int(env.get("PORT", "8080")),
            bind_host=env.get("BIND_HOST", "0.0.0.0"),
            ingest_trigger_secret=env.get("INGEST_TRIGGER_SECRET", ""),
            ingest_source=env.get("INGEST_SOURCE", "financial"),
            trigger_timeout_sec=int(env.get("TRIGGER_TIMEOUT_SEC", "300")),
            lock_path=env.get("PROCESS_LOCK_PATH", "/tmp/process.lock"),
            app_dir=app_dir,
        )


# ---------------------------------------------------------------------------
# Optional dependency on the parallel CS3.12 router — defensive import.
# ---------------------------------------------------------------------------


def _try_load_ingest_router(app_dir: Path) -> Any:
    """Import ``lib.ingest_router`` from ``app_dir`` if present.

    Returns the module or ``None``. Kept as a free function so tests can
    substitute a stub router without monkeypatching ``sys.path``.
    """
    try:
        if str(app_dir) not in sys.path:
            sys.path.insert(0, str(app_dir))
        from lib import ingest_router as _router  # type: ignore  # noqa: E402
        return _router
    except Exception:  # noqa: BLE001 — any import failure is non-fatal
        return None


def resolve_pipeline_script(config: Config, source: str) -> Path | None:
    """Resolve ``source`` → absolute path to the pipeline script.

    Prefers ``config.ingest_router.script_for_source(source)`` when CS3.12
    has shipped; falls back to the hardcoded map otherwise. Returns ``None``
    if the source is unknown.
    """
    router = config.ingest_router
    if router is not None and hasattr(router, "script_for_source"):
        try:
            path_str = router.script_for_source(source)
            if path_str:
                p = Path(path_str)
                return p if p.is_absolute() else (config.app_dir / p)
        except Exception:  # noqa: BLE001
            pass  # fall through to hardcoded map
    script_name = config.fallback_pipelines.get(source)
    if not script_name:
        return None
    return config.app_dir / script_name


# ---------------------------------------------------------------------------
# Structured one-line-JSON logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("trigger_server")


def log_request(
    method: str,
    path: str,
    status: int,
    duration_ms: int,
    caller: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    payload: dict[str, Any] = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
        "method": method,
        "path": path,
        "status": status,
        "duration_ms": duration_ms,
        "caller": caller or "-",
    }
    if extra:
        payload.update(extra)
    log.info(json.dumps(payload, separators=(",", ":")))


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def check_auth(config: Config, headers) -> tuple[bool, str | None]:
    """Validate X-Open-Brain-Caller + Authorization: Bearer headers.

    Returns ``(ok, caller_value_or_reason)``. If
    ``config.ingest_trigger_secret`` is empty, auth is refused — never
    silently no-op.
    """
    caller = headers.get("X-Open-Brain-Caller", "")
    authz = headers.get("Authorization", "")
    if caller != "ingest":
        return False, "bad-caller"
    if not authz.startswith("Bearer "):
        return False, "missing-bearer"
    token = authz[len("Bearer "):].strip()
    if not config.ingest_trigger_secret:
        return False, "server-missing-secret"
    if not hmac.compare_digest(
        token.encode("utf-8"),
        config.ingest_trigger_secret.encode("utf-8"),
    ):
        return False, "bad-token"
    return True, caller


# ---------------------------------------------------------------------------
# File-lock helper — prevents concurrent pipeline runs in the same sidecar.
# ---------------------------------------------------------------------------


class ProcessLock:
    """Non-blocking exclusive flock on ``path``.

    Usage::

        with ProcessLock(path) as lock:
            if not lock.acquired:
                return 409
            # run pipeline
    """

    def __init__(self, path: str):
        self.path = path
        self.fh = None
        self.acquired = False

    def __enter__(self) -> "ProcessLock":
        if _fcntl is None:
            # No fcntl available (Windows test env). Degrade to "always
            # acquires" — production is Linux so this branch is test-only.
            self.acquired = True
            return self
        self.fh = open(self.path, "a+")
        try:
            _fcntl.flock(self.fh.fileno(), _fcntl.LOCK_EX | _fcntl.LOCK_NB)
            self.acquired = True
        except BlockingIOError:
            self.acquired = False
        return self

    def __exit__(self, *exc) -> None:
        if self.fh is not None and _fcntl is not None:
            try:
                if self.acquired:
                    _fcntl.flock(self.fh.fileno(), _fcntl.LOCK_UN)
            finally:
                self.fh.close()
                self.fh = None


def lock_is_held(path: str) -> bool:
    """True iff another process currently holds the lock (no acquire)."""
    if _fcntl is None:
        return False
    try:
        fh = open(path, "a+")
    except OSError:
        return False
    try:
        try:
            _fcntl.flock(fh.fileno(), _fcntl.LOCK_EX | _fcntl.LOCK_NB)
            _fcntl.flock(fh.fileno(), _fcntl.LOCK_UN)
            return False
        except BlockingIOError:
            return True
    finally:
        fh.close()


# ---------------------------------------------------------------------------
# Pipeline invocation
# ---------------------------------------------------------------------------


def run_pipeline(
    config: Config,
    source: str,
    extra_args: list[str] | None = None,
) -> dict[str, Any]:
    """Invoke the pipeline script for ``source`` and return a structured dict.

    Always returns a dict with ``status``, ``exit_code``, ``stderr``,
    ``duration_ms``, ``captures_posted``, ``errors``. Never raises.
    """
    t0 = time.monotonic()
    script = resolve_pipeline_script(config, source)
    if script is None:
        return {
            "status": "error",
            "error": f"unknown source: {source!r}",
            "exit_code": -1,
            "stderr": "",
            "duration_ms": 0,
            "captures_posted": [],
            "errors": [f"unknown source: {source!r}"],
        }
    if not script.exists():
        return {
            "status": "error",
            "error": f"pipeline script missing: {script}",
            "exit_code": -1,
            "stderr": "",
            "duration_ms": 0,
            "captures_posted": [],
            "errors": [f"pipeline script missing: {script}"],
        }

    cmd = [sys.executable, str(script), "--process-inbox", "--json-output"]
    if extra_args:
        cmd.extend(extra_args)

    try:
        proc = subprocess.run(  # noqa: S603 — controlled cmd, no shell
            cmd,
            capture_output=True,
            text=True,
            timeout=config.trigger_timeout_sec,
            check=False,
            cwd=str(config.app_dir),
        )
    except subprocess.TimeoutExpired as e:
        return {
            "status": "error",
            "error": f"pipeline timeout after {config.trigger_timeout_sec}s",
            "exit_code": -1,
            "stderr": (e.stderr or "") if isinstance(e.stderr, str) else "",
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "captures_posted": [],
            "errors": [f"timeout after {config.trigger_timeout_sec}s"],
        }
    except Exception as e:  # noqa: BLE001
        return {
            "status": "error",
            "error": f"subprocess failed: {e}",
            "exit_code": -1,
            "stderr": traceback.format_exc(),
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "captures_posted": [],
            "errors": [str(e)],
        }

    duration_ms = int((time.monotonic() - t0) * 1000)
    summary = parse_json_summary(proc.stdout)

    result: dict[str, Any] = {
        "status": "ok" if proc.returncode == 0 else "error",
        "exit_code": proc.returncode,
        "stderr": (proc.stderr or "")[-8000:],  # cap to avoid huge payloads
        "duration_ms": duration_ms,
        "captures_posted": summary.get("captures_posted", []) if summary else [],
        "errors": summary.get("errors", []) if summary else [],
    }
    if summary and "duration_ms" in summary:
        # Prefer the pipeline's self-reported duration when present.
        result["duration_ms"] = summary["duration_ms"]
    if summary is not None:
        result["stdout_json"] = summary
    return result


def parse_json_summary(stdout: str) -> dict[str, Any] | None:
    """Extract the final JSON object from the pipeline's stdout.

    CS3.9 contract: the last non-empty line of stdout is a JSON summary
    when ``--json-output`` is passed. If that contract isn't yet upheld
    (CS3.9 is a parallel subagent's task), we return ``None`` and the
    caller reports ``captures_posted: []`` instead of failing.
    """
    if not stdout:
        return None
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line:
            continue
        if line.startswith("{") and line.endswith("}"):
            try:
                parsed = json.loads(line)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                return None
        return None  # last non-empty line isn't JSON — bail
    return None


# ---------------------------------------------------------------------------
# HTTP handler factory
# ---------------------------------------------------------------------------


def _make_handler_class(app_config: Config) -> type[BaseHTTPRequestHandler]:
    """Return a ``BaseHTTPRequestHandler`` subclass closed over ``app_config``.

    ``BaseHTTPRequestHandler`` is instantiated fresh per request by the
    server, so we can't pass config through ``__init__``. Instead, we stamp
    it as a class attribute on a freshly-minted subclass. Parameter name is
    ``app_config`` so the class-body assignment ``config = app_config``
    resolves via enclosing scope (class bodies don't see their own name as
    an RHS under Python 3.14 annotation scoping).
    """

    class TriggerHandler(BaseHTTPRequestHandler):
        # Class attribute — shared across all request instances.
        config = app_config

        # Silence default per-request access log — we emit our own.
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

        # -- helpers --------------------------------------------------------

        def _write_json(self, status: int, body: dict[str, Any]) -> None:
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except BrokenPipeError:
                pass

        def _read_json_body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length <= 0:
                return {}
            raw = self.rfile.read(length)
            if not raw:
                return {}
            try:
                parsed = json.loads(raw.decode("utf-8"))
                return parsed if isinstance(parsed, dict) else {}
            except (json.JSONDecodeError, UnicodeDecodeError):
                return {}

        # -- GET ------------------------------------------------------------

        def do_GET(self) -> None:  # noqa: N802 — stdlib name
            t0 = time.monotonic()
            path = self.path.split("?", 1)[0]
            try:
                if path == "/healthz":
                    self._write_json(HTTPStatus.OK, {"status": "ok"})
                    log_request(
                        "GET", path, 200,
                        int((time.monotonic() - t0) * 1000),
                    )
                    return
                if path == "/health":
                    busy = lock_is_held(self.config.lock_path)
                    status = HTTPStatus.CONFLICT if busy else HTTPStatus.OK
                    self._write_json(
                        status,
                        {
                            "status": "busy" if busy else "idle",
                            "source": self.config.ingest_source,
                        },
                    )
                    log_request(
                        "GET", path, int(status),
                        int((time.monotonic() - t0) * 1000),
                    )
                    return
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                log_request(
                    "GET", path, 404,
                    int((time.monotonic() - t0) * 1000),
                )
            except Exception as e:  # noqa: BLE001
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": str(e), "traceback": traceback.format_exc()[-2000:]},
                )
                log_request(
                    "GET", path, 500,
                    int((time.monotonic() - t0) * 1000),
                )

        # -- POST -----------------------------------------------------------

        def do_POST(self) -> None:  # noqa: N802 — stdlib name
            t0 = time.monotonic()
            path = self.path.split("?", 1)[0]
            try:
                ok, caller_or_reason = check_auth(self.config, self.headers)
                if not ok:
                    self._write_json(
                        HTTPStatus.UNAUTHORIZED,
                        {"error": "unauthorized", "reason": caller_or_reason},
                    )
                    log_request(
                        "POST", path, 401,
                        int((time.monotonic() - t0) * 1000),
                        caller=caller_or_reason,
                    )
                    return

                # Determine source
                source: str | None = None
                if path == "/process":
                    body = self._read_json_body()
                    source = body.get("source") or self.config.ingest_source
                elif path.startswith("/trigger/"):
                    source = path[len("/trigger/"):].strip("/") or None
                    # body is optional; reading it consumes it so downstream
                    # code doesn't see a dangling body on keep-alive sockets.
                    self._read_json_body()
                else:
                    self._write_json(
                        HTTPStatus.NOT_FOUND, {"error": "not found"},
                    )
                    log_request(
                        "POST", path, 404,
                        int((time.monotonic() - t0) * 1000),
                        caller=caller_or_reason,
                    )
                    return

                if not source:
                    self._write_json(
                        HTTPStatus.BAD_REQUEST,
                        {
                            "error": "missing source",
                            "hint": (
                                "POST /process with bound INGEST_SOURCE or "
                                "/trigger/{source}"
                            ),
                        },
                    )
                    log_request(
                        "POST", path, 400,
                        int((time.monotonic() - t0) * 1000),
                        caller=caller_or_reason,
                    )
                    return

                # Acquire the process lock; refuse concurrent runs with 409.
                with ProcessLock(self.config.lock_path) as lock:
                    if not lock.acquired:
                        self._write_json(
                            HTTPStatus.CONFLICT,
                            {
                                "status": "busy",
                                "error": "pipeline already running",
                            },
                        )
                        log_request(
                            "POST", path, 409,
                            int((time.monotonic() - t0) * 1000),
                            caller=caller_or_reason,
                            extra={"source": source},
                        )
                        return

                    result = run_pipeline(self.config, source)

                http_status = (
                    HTTPStatus.OK if result["status"] == "ok"
                    else HTTPStatus.INTERNAL_SERVER_ERROR
                )
                self._write_json(int(http_status), result)
                log_request(
                    "POST", path, int(http_status),
                    int((time.monotonic() - t0) * 1000),
                    caller=caller_or_reason,
                    extra={
                        "source": source,
                        "exit_code": result.get("exit_code"),
                        "captures_posted": len(result.get("captures_posted", [])),
                    },
                )
            except Exception as e:  # noqa: BLE001 — never crash the server
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": str(e),
                        "traceback": traceback.format_exc()[-2000:],
                    },
                )
                log_request(
                    "POST", path, 500,
                    int((time.monotonic() - t0) * 1000),
                )

    return TriggerHandler


def create_app(config: Config) -> ThreadingHTTPServer:
    """Build a ``ThreadingHTTPServer`` bound to ``(config.bind_host, config.port)``.

    The handler class is freshly minted with ``config`` closed over, so multiple
    ``create_app`` calls in the same process (e.g., tests) are independent.
    """
    handler_cls = _make_handler_class(config)
    return ThreadingHTTPServer((config.bind_host, config.port), handler_cls)


# ---------------------------------------------------------------------------
# Server lifecycle + graceful shutdown
# ---------------------------------------------------------------------------


def _install_signal_handlers(
    server: ThreadingHTTPServer, stop_event: threading.Event,
) -> None:
    def _shutdown(signum: int, _frame: Any) -> None:
        log.info(json.dumps({
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
            "event": "shutdown",
            "signal": signum,
        }, separators=(",", ":")))
        stop_event.set()
        # server.shutdown() must run from a different thread than serve_forever
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)


def main(config: Config | None = None) -> int:
    if config is None:
        config = Config.from_env()
        # Wire the optional CS3.12 router discovered on disk. Done here (not in
        # from_env) so tests can inject a stub router without hitting sys.path.
        if config.ingest_router is None:
            router = _try_load_ingest_router(config.app_dir)
            if router is not None:
                config = Config(
                    port=config.port,
                    bind_host=config.bind_host,
                    ingest_trigger_secret=config.ingest_trigger_secret,
                    ingest_source=config.ingest_source,
                    trigger_timeout_sec=config.trigger_timeout_sec,
                    lock_path=config.lock_path,
                    app_dir=config.app_dir,
                    fallback_pipelines=config.fallback_pipelines,
                    ingest_router=router,
                )

    if not config.ingest_trigger_secret:
        log.warning(json.dumps({
            "event": "startup_warning",
            "message": (
                "INGEST_TRIGGER_SECRET is not set — all POST requests will be "
                "rejected. Set INGEST_TRIGGER_SECRET in the compose env."
            ),
        }))

    if config.ingest_source not in config.fallback_pipelines:
        log.warning(json.dumps({
            "event": "startup_warning",
            "message": (
                f"INGEST_SOURCE={config.ingest_source!r} is not a known pipeline"
            ),
            "known": list(config.fallback_pipelines.keys()),
        }))

    server = create_app(config)
    stop_event = threading.Event()
    _install_signal_handlers(server, stop_event)

    log.info(json.dumps({
        "event": "startup",
        "port": config.port,
        "bind": config.bind_host,
        "source": config.ingest_source,
        "timeout_sec": config.trigger_timeout_sec,
        "router_loaded": config.ingest_router is not None,
    }, separators=(",", ":")))

    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        log.info(json.dumps({"event": "stopped"}, separators=(",", ":")))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
