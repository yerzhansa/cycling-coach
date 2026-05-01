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

# Workspace manifests + lockfile for cache hits on dep installs. Only the
# packages cycling-coach actually depends on (core + sport-cycling + itself);
# the 4 stub packages aren't part of the binary and don't need to be visible.
# `pnpm install --filter cycling-coach...` resolves only the cycling-coach
# subgraph and ignores the absent stub workspace dirs.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/sport-cycling/package.json ./packages/sport-cycling/
COPY packages/cycling-coach/package.json ./packages/cycling-coach/

RUN pnpm install --filter cycling-coach... --frozen-lockfile

# Source after deps for cache reuse.
COPY tools ./tools
COPY packages/core ./packages/core
COPY packages/sport-cycling ./packages/sport-cycling
COPY packages/cycling-coach ./packages/cycling-coach

# Only build what cycling-coach needs (`...` = the package + all its deps in
# topo order). Stubs aren't even copied into the image.
RUN pnpm --filter cycling-coach... build

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
