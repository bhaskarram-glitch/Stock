# infra/docker/Dockerfile — ingest worker image.
# Build context is the REPO ROOT (needs packages/shared + tsconfig.base.json):
#   docker build -f infra/docker/Dockerfile -t stock-ingest-worker .
# Same image runs the streaming worker and the jobs; WORKER_MODE / command select the behaviour.

# ---- build stage -------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /repo

COPY apps/ingest-worker/package.json apps/ingest-worker/package-lock.json ./apps/ingest-worker/
RUN cd apps/ingest-worker && npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/ingest-worker ./apps/ingest-worker
RUN cd apps/ingest-worker && npm run build

# ---- runtime stage -----------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY apps/ingest-worker/package.json apps/ingest-worker/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /repo/apps/ingest-worker/dist ./dist

# Non-root, no shell needed
USER node

# Healthcheck reuses the worker's own healthcheck mode (exit code = status)
HEALTHCHECK --interval=5m --timeout=30s --start-period=30s --retries=3 \
  CMD WORKER_MODE=healthcheck node dist/apps/ingest-worker/src/index.js || exit 1

CMD ["node", "dist/apps/ingest-worker/src/index.js"]