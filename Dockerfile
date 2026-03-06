# syntax=docker/dockerfile:1

# ============================================================
# Base stage — pnpm + node setup
# ============================================================
FROM node:20-alpine AS base
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
RUN pnpm -r build

# ============================================================
# Production base — minimal runtime image
# ============================================================
FROM node:20-alpine AS prod-base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
RUN apk add --no-cache bash

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
ENV NODE_ENV=production
CMD ["node", "packages/workers/dist/index.js"]

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
CMD ["node", "packages/voice-capture/dist/index.js"]
