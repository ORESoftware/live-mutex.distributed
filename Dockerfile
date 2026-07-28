# syntax=docker/dockerfile:1.6

FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm rebuild @oresoftware/f2e

COPY tsconfig.json tsconfig.esm.json tsconfig.test.json ./
COPY .cli-flags.toml ./
COPY src ./src
COPY scripts/add-esm-extensions.js scripts/fix-commonjs-import-meta.js scripts/sync-broker-cli-config.js ./scripts/
RUN npm run build

RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm rebuild @oresoftware/f2e

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    live_mutex_host=0.0.0.0 \
    live_mutex_port=6970 \
    lmx_in_docker=yes \
    bunion_producer_level=WARN

COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --from=build --chown=1000:1000 /app/.cli-flags.toml ./.cli-flags.toml
COPY --from=build --chown=1000:1000 /app/package.json ./package.json

USER 1000:1000
EXPOSE 6970
ENTRYPOINT ["node", "dist/lm-start-server.js"]
