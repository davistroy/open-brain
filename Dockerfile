# syntax=docker/dockerfile:1

# ============================================================
# Base stage — pnpm + node setup
# ============================================================
FROM node:26-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ============================================================
# Dependencies stage — install all workspace deps
# ============================================================
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core-api/package.json ./packages/core-api/
COPY packages/slack-bot/package.json ./packages/slack-bot/
COPY packages/workers/package.json ./packages/workers/
COPY packages/voice-capture/package.json ./packages/voice-capture/
RUN pnpm install --frozen-lockfile

# ============================================================
# Build stage — build all packages
# ============================================================
FROM deps AS builder
COPY tsconfig.base.json ./
COPY packages/ ./packages/
RUN pnpm --filter @open-brain/shared build \
    && pnpm --filter @open-brain/core-api build \
    && pnpm --filter @open-brain/workers build \
    && pnpm --filter @open-brain/voice-capture build \
    && pnpm --filter @open-brain/slack-bot build

# Verify expected build outputs exist
RUN test -f packages/core-api/dist/index.js \
    && test -f packages/workers/dist/main.js \
    && test -f packages/voice-capture/dist/server.js \
    && test -f packages/slack-bot/dist/index.js

# ============================================================
# Production base — minimal runtime image
# ============================================================
FROM node:26-alpine AS prod-base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
RUN apk add --no-cache bash git postgresql-client

# ============================================================
# core-api target
# ============================================================
FROM prod-base AS core-api
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core-api/package.json ./packages/core-api/
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/core-api/dist ./packages/core-api/dist
# Migrations will be copied here in a later phase
ENV NODE_ENV=production
EXPOSE 3000
# SEC-A6: compose mounts ./config:ro (read-only, no ownership concern) PLUS the
# `admin_prewipe_backup` NAMED volume at /backup/pre-wipe — WRITABLE, used by
# POST /admin/reset-data's pg_dump-before-TRUNCATE safety backup (fail-closed:
# a write failure there ABORTS the wipe rather than proceeding without a
# backup, so a permission problem degrades to "reset-data 500s" not silent data
# loss). Pre-creating the dir as node:node here only seeds a BRAND-NEW volume
# with the right ownership (Docker copies the image dir's perms into an empty
# named volume on first mount) — it does NOT retroactively fix an
# already-populated volume. Operator note: the homeserver's existing
# `admin_prewipe_backup` volume predates this change and was created under the
# old root-running container; it needs a one-time
# `docker run --rm -v open-brain_admin_prewipe_backup:/v alpine chown -R 1000:1000 /v`
# (or equivalent) before/at this deploy, or reset-data will 500 until then.
RUN mkdir -p /backup/pre-wipe && chown -R node:node /app /backup/pre-wipe
USER node
CMD ["sh", "-c", "node packages/core-api/dist/index.js"]

# ============================================================
# slack-bot target
# ============================================================
FROM prod-base AS slack-bot
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/slack-bot/package.json ./packages/slack-bot/
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/slack-bot/dist ./packages/slack-bot/dist
ENV NODE_ENV=production
# SEC-A6: no writable volumes for this target (compose mounts ./config:ro only) —
# safe to run as the non-root `node` user (UID 1000) that ships in node:22-alpine.
RUN chown -R node:node /app
USER node
CMD ["node", "packages/slack-bot/dist/index.js"]

# ============================================================
# workers target
# ============================================================
FROM prod-base AS workers
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/workers/package.json ./packages/workers/
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/workers/dist ./packages/workers/dist
# Himalaya CLI v1.2.0 — outbound email via SMTP
RUN wget -qO- https://github.com/pimalaya/himalaya/releases/download/v1.2.0/himalaya.x86_64-linux.tgz \
    | tar xz -C /usr/local/bin himalaya \
    && chmod +x /usr/local/bin/himalaya
ENV NODE_ENV=production
CMD ["node", "packages/workers/dist/main.js"]

# ============================================================
# voice-capture target
# ============================================================
FROM prod-base AS voice-capture
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/voice-capture/package.json ./packages/voice-capture/
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/voice-capture/dist ./packages/voice-capture/dist
ENV NODE_ENV=production
EXPOSE 3001
# SEC-A6: writes to the `voice_spool_data` named volume (INT-M4 dead-letter spool
# for transcripts) at /data/voice-spool — must exist AND be owned by `node`
# BEFORE the USER switch, or the spool write silently fails (transcript loss on
# a downstream 502, not just a permission error surfaced to a caller). Same
# caveat as core-api's /backup/pre-wipe: this only seeds ownership for a
# BRAND-NEW volume — the homeserver's existing `voice_spool_data` volume
# predates this change and needs a one-time
# `docker run --rm -v open-brain_voice_spool_data:/v alpine chown -R 1000:1000 /v`
# before/at this deploy.
RUN mkdir -p /data/voice-spool && chown -R node:node /app /data/voice-spool
USER node
CMD ["node", "packages/voice-capture/dist/server.js"]
