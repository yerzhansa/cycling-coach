# syntax=docker/dockerfile:1.7

# ── builder ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV CYCLING_COACH_HOME=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY SOUL.md ./SOUL.md
COPY skills ./skills

RUN addgroup -S app && adduser -S -G app app \
    && mkdir -p /data \
    && chown -R app:app /data /app

USER app
VOLUME ["/data"]

CMD ["node", "dist/index.js"]
