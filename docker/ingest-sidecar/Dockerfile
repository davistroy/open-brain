# Open Brain — Python batch-ingest sidecar
# Runs the financial-pipeline.py and (optionally) utility-pipeline.py scripts
# against CSVs dropped into /inbox. Posts captures to the core-api.
#
# Exposes a stdlib HTTP trigger on :8080 (trigger_server.py) for core-api's
# ingest-process worker to dispatch POST /process over the internal Docker
# network with HMAC auth (INGEST_TRIGGER_SECRET). Host cron also exec's into
# this container for scheduled batch runs:
#   docker exec open-brain-financial-ingest python /app/financial-pipeline.py --process-inbox

FROM python:3.12-slim

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

# electric-usage-downloader — SmartHub cooperative usage downloader used by
# utility-pipeline.py --power-summary. Pinned to a known-good release.
# Repository: https://github.com/typ0/electric-usage-downloader
# (the plan doc references github.com/tom/electric-usage-downloader — if
#  that URL 404s, use typ0's fork which is the active one as of 2026-04)
#
# TODO: The exact GitHub release asset name format is unverified against the
# upstream repo (no network access during this build). Version 0.5.0 is a
# placeholder. If the build fails here, adjust EUD_VERSION and/or the asset
# filename pattern below to match an actual release from
# https://github.com/typ0/electric-usage-downloader/releases
ARG EUD_VERSION=0.5.0
RUN ARCH="$(uname -m)" && case "$ARCH" in \
      x86_64)  EUD_ARCH="linux_amd64" ;; \
      aarch64) EUD_ARCH="linux_arm64" ;; \
      *) echo "unsupported arch for electric-usage-downloader: $ARCH"; exit 1 ;; \
    esac && \
    curl -sL "https://github.com/typ0/electric-usage-downloader/releases/download/v${EUD_VERSION}/electric-usage-downloader_${EUD_VERSION}_${EUD_ARCH}.tar.gz" -o /tmp/eud.tar.gz && \
    tar -xzf /tmp/eud.tar.gz -C /tmp && \
    mv /tmp/electric-usage-downloader /usr/local/bin/electric-usage-downloader && \
    chmod +x /usr/local/bin/electric-usage-downloader && \
    rm -rf /tmp/eud.tar.gz /tmp/LICENSE /tmp/README.md 2>/dev/null || true

# Pipeline dependencies. Kept minimal — pdfplumber etc. deliberately excluded
# until a script actually needs them. Adding a package here is cheap.
RUN pip install --no-cache-dir \
      requests==2.32.3 \
      PyYAML==6.0.2

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
# HTTP trigger server (stdlib) — core-api dispatches POST /process here via
# INGEST_TRIGGER_SECRET HMAC. Serializes pipeline runs via fcntl file lock.
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
