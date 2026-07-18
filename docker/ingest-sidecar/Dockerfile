# Open Brain — Python batch-ingest sidecar
# Runs the financial-pipeline.py and (optionally) utility-pipeline.py scripts
# against CSVs dropped into /inbox. Posts captures to the core-api.
#
# Exposes a stdlib HTTP trigger on :8080 (trigger_server.py) for core-api's
# ingest-process worker to dispatch POST /process over the internal Docker
# network with a bearer-token auth (INGEST_TRIGGER_SECRET, constant-time compare
# — NOT HMAC/signed). Host cron also exec's into
# this container for scheduled batch runs:
#   docker exec open-brain-financial-ingest python /app/financial-pipeline.py --process-inbox

FROM python:3.14-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates tzdata unzip \
    && rm -rf /var/lib/apt/lists/*

# Bitwarden Secrets Manager CLI (pinned).
# Scripts use `bws secret list` to retrieve API keys + merchant rules.
ARG BWS_VERSION=1.0.0
RUN ARCH="$(uname -m)" && case "$ARCH" in \
      x86_64)  BWS_ARCH="x86_64-unknown-linux-gnu" ;; \
      aarch64) BWS_ARCH="aarch64-unknown-linux-gnu" ;; \
      *) echo "unsupported arch: $ARCH"; exit 1 ;; \
    esac && \
    curl -sL "https://github.com/bitwarden/sdk-sm/releases/download/bws-v${BWS_VERSION}/bws-${BWS_ARCH}-${BWS_VERSION}.zip" -o /tmp/bws.zip && \
    unzip -o /tmp/bws.zip -d /tmp/ && \
    mv /tmp/bws /usr/local/bin/bws && \
    chmod +x /usr/local/bin/bws && \
    rm -rf /tmp/bws.zip

# electric-usage-downloader — SmartHub cooperative usage downloader, intended for
# utility-pipeline.py --power-summary.
# Repository: https://github.com/tedpearson/electric-usage-downloader  (51 stars,
# active) — which is exactly what config/utility/utility-config.yaml has said all
# along. `typ0` never existed.
#
# ── #286: this block installed NOTHING for months, and could not fail ──────────
# Three independent errors, each sufficient on its own — all three verified live
# on 2026-07-15 before this rewrite:
#   1. org      `typ0/...`             -> HTTP 404 (repo does not exist)
#   2. version  `0.5.0`                -> latest is v2.4.1
#   3. format   `..._linux_amd64.tar.gz` -> assets are RAW BINARIES
#                                          (`electric-usage-downloader-linux-amd64`);
#                                          there is no tarball, so `tar -xzf` also fails
#
# It never surfaced because the failure was engineered out of existence:
#   * `curl -sL` WITHOUT `-f` writes the 404 body to disk and exits 0
#   * a trailing `|| true` terminated the whole `&&` chain, so ANY failure -> exit 0
# The old comment even said "If the build fails here, adjust EUD_VERSION" — while
# `|| true` structurally guaranteed it never would. A TODO that cannot fire is not
# a TODO.
#
# `RUN electric-usage-downloader --help` below is the guard: it is the Dockerfile's
# equivalent of Entry 200's rule — never ship a thing that has not been RUN. It
# converts a silent no-op into a build failure, which is the point.
#
# ⚠️ This image is SHARED by utility-ingest AND financial-ingest (D140/Entry 201):
# a failure here blocks BOTH. That is correct — a broken install should stop the
# release, not ship quietly.
#
# NOTE: installing the binary does NOT make power ingestion work. Nothing invokes
# it (`cmd_power_summary` is a TODO stub) and its data dir is not a volume. See
# #286 / OA-22 — that is a scoping decision, not a bug fix.
ARG EUD_VERSION=2.4.1
RUN ARCH="$(uname -m)" && case "$ARCH" in \
      x86_64)  EUD_ARCH="linux-amd64" ;; \
      aarch64) EUD_ARCH="linux-arm64" ;; \
      *) echo "unsupported arch for electric-usage-downloader: $ARCH"; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/tedpearson/electric-usage-downloader/releases/download/v${EUD_VERSION}/electric-usage-downloader-${EUD_ARCH}" \
      -o /usr/local/bin/electric-usage-downloader && \
    chmod +x /usr/local/bin/electric-usage-downloader && \
    electric-usage-downloader --help > /dev/null 2>&1 || \
      electric-usage-downloader --version > /dev/null 2>&1 || \
      { echo "electric-usage-downloader installed but not executable — refusing to ship"; exit 1; }

# Pipeline dependencies. Kept minimal — a package earns its place by being
# imported by a script that actually runs. Adding one here is cheap.
#
# PyMuPDF: utility-pipeline.py parses Gas South bill PDFs for therms. It was
# missing for the entire life of the gas path — unnoticed because auth was
# broken upstream, so the parse never ran and therms silently stored as NULL
# (#275). AGPL-3.0, accepted for this self-hosted single-user deployment.
# PyYAML 6.0.3 / requests 2.34.2 (not 6.0.2 / 2.32.3): 6.0.2 has NO cp314 wheel,
# so on python:3.14 it source-builds (works via the pure-Python fallback, but a
# prod image should not depend on an sdist fallback). 6.0.3 ships a clean cp314
# wheel. These now match docker/ingest-sidecar/tests/requirements.txt exactly.
# PyMuPDF 1.28.0's cp310-abi3 wheel already covers 3.14. (Verified in-image, Entry 241.)
RUN pip install --no-cache-dir \
      requests==2.34.2 \
      PyYAML==6.0.3 \
      PyMuPDF==1.28.0

# Defaults for in-container paths. Overrideable via compose environment.
ENV PYTHONUNBUFFERED=1 \
    FINANCIAL_INBOX_DIR=/inbox \
    FINANCIAL_PIPE_DIR=/data \
    FINANCIAL_CONFIG_DIR=/app/config/financial \
    TZ=America/New_York

WORKDIR /app
COPY scripts/financial-pipeline.py /app/financial-pipeline.py
COPY scripts/utility-pipeline.py  /app/utility-pipeline.py
# Shared Python helpers (capture_api, ingest_router when CS3 lands)
COPY scripts/lib /app/lib
COPY config /app/config
# HTTP trigger server (stdlib) — core-api dispatches POST /process here with the
# INGEST_TRIGGER_SECRET bearer token (constant-time compare, not HMAC/signed).
# Serializes pipeline runs via fcntl file lock.
COPY docker/ingest-sidecar/trigger_server.py /app/trigger_server.py

# Directories the script writes to at runtime. Named volumes mount over these.
RUN mkdir -p /inbox /inbox/processed /data

# Trigger server listens on :8080; compose networks expose it to core-api.
EXPOSE 8080

# SEC-A6 (Entry 8.5): DEFERRED — stays root. Unlike the other targets in this
# repo, /inbox is a raw HOST BIND MOUNT on Unraid
# (/mnt/user/appdata/open-brain/{financial,utility}-inbox:/inbox), not a
# Docker-managed named volume — its ownership is whatever the Unraid host
# filesystem assigns (root or an Unraid-specific UID unrelated to any
# in-container UID), and Docker does NOT auto-chown bind-mount content the way
# it seeds a brand-new named volume. Also: host cron `docker exec`'s directly
# into this container (see header comment) to run financial-pipeline.py /
# utility-pipeline.py, and file ownership must line up for BOTH the trigger
# server's writes (/inbox/processed, /data) AND those exec'd cron invocations.
# Pinning a non-root UID here without first coordinating a matching host-side
# UID (or a Docker `user:` override sourced from the host's UID at deploy
# time) risks breaking the host cron -> container write path silently. Needs
# a dedicated host-UID-coordination pass — tracked as a follow-up, not done in
# this hardening pass. Root is an accepted, documented exception for this
# target only.
CMD ["python", "/app/trigger_server.py"]
