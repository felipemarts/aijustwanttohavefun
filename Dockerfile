# syntax=docker/dockerfile:1
#
# Production image: the game server (TypeScript run by tsx, no build step for the workspace packages) serving the
# built web app. Multi-stage: dependencies are fetched from the lockfile alone (cached until it changes), the web
# app is built, then a production-only install of the server and its workspace packages is copied into a slim
# runtime that runs as `node` (uid 1000) and works with a read-only root filesystem (only /tmp must be writable).
#
#   docker build -t ajwf .
#   docker run --read-only --tmpfs /tmp -p 8710:8710 --env-file .env ajwf
#   docker run --rm --env-file .env ajwf node --import tsx src/db/migrate.ts    # migrations only (they also run at boot)

ARG NODE_IMAGE=node:22.22.2-alpine3.22

# ── fetch: the package store, from the lockfile only ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS fetch
ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --store-dir /store

# ── build: install everything offline and build the web app ──────────────────────────────────────────────────────
FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile --store-dir /store \
 && pnpm --filter @ajwf/web build

# ── prod: only what the server needs at run time ─────────────────────────────────────────────────────────────────
FROM fetch AS prod
COPY . .
# Production dependencies of the server and of the workspace packages it uses (engine, content, i18n, ...).
# `pnpm fetch` left a full virtual store in node_modules: start from an empty one.
RUN rm -rf node_modules && pnpm install --offline --frozen-lockfile --prod --store-dir /store --filter "@ajwf/server..." \
 && find packages apps/server -name '*.test.ts' -delete
COPY --from=build /repo/apps/web/dist /repo/apps/web/dist

# ── runtime ──────────────────────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
# tini as PID 1: forwards SIGTERM to Node (whose handler takes the final snapshot) and reaps zombies.
RUN apk add --no-cache tini
# Sprite and share-card caches go to /tmp (a tmpfs with a read-only root; mount a volume there to keep them).
# The V8 heap limit keeps the process under the 2 GB target (buffers, sockets and zlib live outside the heap).
ENV NODE_ENV=production \
    PORT=8710 \
    WEB_DIST=/app/apps/web/dist \
    CACHE_DIR=/tmp/ajwf-cache \
    TMPDIR=/tmp \
    NODE_OPTIONS="--max-old-space-size=1536 --enable-source-maps"
WORKDIR /app
COPY --from=prod --chown=root:root /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=prod --chown=root:root /repo/node_modules ./node_modules
COPY --from=prod --chown=root:root /repo/packages ./packages
COPY --from=prod --chown=root:root /repo/public-docs ./public-docs
COPY --from=prod --chown=root:root /repo/apps/server ./apps/server
COPY --from=prod --chown=root:root /repo/apps/web/dist ./apps/web/dist
USER node
WORKDIR /app/apps/server
EXPOSE 8710
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "src/main.ts"]
