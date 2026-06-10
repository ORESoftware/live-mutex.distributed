# live-mutex.distributed consensus-node (`lmxd`) image.
#
# Build context MUST be the repo root. Build with:
#   docker build -f deploy/Dockerfile -t live-mutex-distributed:dev .
#
# The distributed engine (src/distributed/*) imports ONLY Node built-ins
# (net/events/readline), so the runtime image needs no node_modules — just the
# compiled JS. postinstall is skipped (--ignore-scripts) because the repo's
# postinstall hook is irrelevant to the daemon and not container-safe.

# ---- builder ---------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.distributed.json ./
COPY src ./src
COPY test ./test
# tsconfig.distributed.json -> outDir: dist  =>  dist/src/distributed/lmxd.js
RUN npx tsc -p tsconfig.distributed.json

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# getent (glibc) lets the entrypoint wait for the pod's own DNS A record before
# the node binds its peer FQDN (the transport listens on addresses[id] literally).
WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0555 /usr/local/bin/docker-entrypoint.sh

# Run as a non-root, unprivileged numeric UID. The node binds only a high port
# (9000), holds no on-disk state, and the entrypoint only reads DNS — so this
# works with a read-only root filesystem (see the StatefulSet securityContext).
USER 65532:65532

EXPOSE 9000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
