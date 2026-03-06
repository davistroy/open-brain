# syntax=docker/dockerfile:1
# Multi-stage build for Open Brain web dashboard
# Stage 1: Build the Vite SPA
# Stage 2: Serve with nginx:alpine, proxy /api to core-api

# ============================================================
# Build stage
# ============================================================
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Copy workspace manifests and lockfile
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package.json ./packages/web/

# Install all deps (dev included for build)
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/web/ ./packages/web/

# Build shared first, then web
RUN pnpm --filter @open-brain/shared build
RUN pnpm --filter @open-brain/web build

# ============================================================
# Runtime stage — nginx:alpine
# ============================================================
FROM nginx:1.27-alpine AS runtime

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built SPA
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost/health.txt || exit 1

CMD ["nginx", "-g", "daemon off;"]
