# syntax=docker/dockerfile:1
# Multi-stage build for Open Brain web-next (Next.js 16 standalone)
# IMPORTANT: Do NOT use --report-on-fatalerror in NODE_OPTIONS — it crashes
# Turbopack worker threads on Next.js 16. Use --max-old-space-size only.

# ============================================================
# Builder stage — install deps and build standalone output
# ============================================================
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Copy workspace manifests + lockfile (triggers pnpm install cache layer)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./

# Copy only the package.json files needed to resolve the workspace graph
COPY packages/shared/package.json ./packages/shared/
COPY packages/web-next/package.json ./packages/web-next/

# Install all deps (dev included — Next.js build needs them)
RUN pnpm install --frozen-lockfile

# Copy full source trees for the packages we build
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/web-next/ ./packages/web-next/

# Build shared first (web-next imports shared types at build time)
RUN pnpm --filter @open-brain/shared build

# Build Next.js with standalone output
# outputFileTracingRoot in next.config.ts traces workspace deps so the
# standalone bundle is self-contained at /app/packages/web-next/.next/standalone/
RUN NODE_OPTIONS="--max-old-space-size=4096" \
    pnpm --filter @open-brain/web-next build

# ============================================================
# Runtime stage — minimal Node image, standalone output only
# ============================================================
FROM node:22-alpine AS runtime

WORKDIR /app

# Copy the entire standalone directory (includes traced workspace deps)
COPY --from=builder /app/packages/web-next/.next/standalone/ ./

# Copy static assets — standalone does NOT include these; serve from FS
# Target path must match Next.js expectation:
#   .next/static/ is served by standalone server from the working dir
COPY --from=builder /app/packages/web-next/.next/static/ \
     ./packages/web-next/.next/static/

# Copy public assets
COPY --from=builder /app/packages/web-next/public/ \
     ./packages/web-next/public/

ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

EXPOSE 3001

# Next.js standalone entrypoint is generated at the root of standalone/
# The server.js is placed at packages/web-next/server.js relative to standalone root
CMD ["node", "packages/web-next/server.js"]

# Healthcheck — use 127.0.0.1 not localhost (Alpine resolves localhost to IPv6
# ::1 which fails wget; 127.0.0.1 is always IPv4)
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3001/dashboard || exit 1
