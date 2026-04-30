# syntax=docker/dockerfile:1.7

# Multi-stage Dockerfile for the cycling-coach binary. Builds Core + sport-cycling
# + cycling-coach via pnpm workspace, then ships only the runtime bundle via
# `pnpm deploy --prod` (pnpm-canonical: rewrites workspace:* to real paths,
# strips dev deps, produces a self-contained directory).

# ── builder ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Honor the packageManager pin in root package.json.
RUN corepack enable

# Workspace manifests first for cache hits on dep installs.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/sport-cycling/package.json ./packages/sport-cycling/
COPY packages/cycling-coach/package.json ./packages/cycling-coach/

RUN pnpm install --frozen-lockfile

# Source after deps for cache reuse.
COPY tools ./tools
COPY packages ./packages

RUN pnpm -r build

# pnpm deploy: produces a self-contained dir with prod-only deps,
# resolves workspace:* to actual files, the pnpm-canonical Docker pattern.
RUN pnpm --filter cycling-coach --prod deploy /app/runtime-bundle

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV CYCLING_COACH_HOME=/data

COPY --from=builder /app/runtime-bundle ./

RUN mkdir -p /data

CMD ["node", "dist/index.js"]
