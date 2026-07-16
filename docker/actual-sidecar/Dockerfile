# Open Brain — Actual Budget daily-ingest sidecar (issue #311 / spec 2026-07-15)
#
# A NEW image, deliberately its own (spec §3.2): @actual-app/api is Node-only,
# and the Python `ingest-sidecar:latest` is already SHARED by two services — the
# exact configuration that let financial-ingest sit on a 2-month-stale image
# (D140/Entry 201). A third consumer would deepen that trap; a separate image
# keeps the blast radius at one service.
#
# node:22-slim (Debian/glibc), NOT alpine/musl: @actual-app/api pulls
# better-sqlite3, which ships glibc prebuilds — so `npm ci` needs no compiler
# here (spec §2). This is the whole reason this cannot live in the Alpine
# `workers` image.
#
# Long-running container; host cron drives one run per day (spec §3.3):
#   docker exec open-brain-actual-ingest node /app/actual-daily.mjs
# The homeserver TZ is America/New_York, so a host cron `0 6 * * *` fires at 6am
# ET natively — sidestepping #295 (BullMQ's UTC cron) entirely.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=America/New_York \
    ACTUAL_DATA_DIR=/data/actual \
    ACTUAL_STATE_PATH=/data/state.json \
    ACTUAL_RULES_PATH=/app/config/payee-rules.yaml \
    CORE_API_URL=http://core-api:3000

WORKDIR /app

# Install production deps first for layer caching. Standalone npm project (its
# own package-lock.json), outside the pnpm workspace — mirrors cloudflare/email-worker.
COPY scripts/actual/package.json scripts/actual/package-lock.json ./
RUN npm ci --omit=dev

# Application code (the tested lib units + the thin wiring entrypoint).
COPY scripts/actual/actual-daily.mjs ./actual-daily.mjs
COPY scripts/actual/lib ./lib

# /data (named volume) holds the Actual dataDir + last-run balance state.
# config/payee-rules.yaml arrives via a read-only bind mount (./config:/app/config:ro);
# it is host-only and never baked into this image (contains real merchant names).
RUN mkdir -p /data

# Stays root, documented — consistent with the Python ingest-sidecar (host cron
# `docker exec`s in, and /data is a Docker-managed named volume seeded on first
# use). A non-root transition would need a one-time volume chown (cf. OA-15);
# deferred, not required here.
#
# No server process: the container idles so host cron can `docker exec` a run.
# Compose sets `init: true` so signals are reaped cleanly.
CMD ["sleep", "infinity"]
