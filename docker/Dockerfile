ARG SS_VERSION=26.8.10
FROM node:22-bookworm-slim AS dependency-base

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

FROM dependency-base AS production-dependencies

COPY package*.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --workspace server; else npm install --omit=dev --workspace server; fi \
  && test -f node_modules/better-sqlite3/prebuilds/linux-x64.node \
  && find node_modules/better-sqlite3/prebuilds -type f ! -name linux-x64.node -delete \
  && rm -rf node_modules/better-sqlite3/build \
    node_modules/better-sqlite3/deps \
    node_modules/better-sqlite3/src \
    node_modules/better-sqlite3/binding.gyp \
    node_modules/node-addon-api \
  && test "$(find node_modules/better-sqlite3/prebuilds -type f | wc -l)" -eq 1 \
  && node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.exec('SELECT 1'); db.close()"

FROM dependency-base AS build

COPY package*.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY shared shared
COPY server server
COPY web web
COPY scripts scripts
COPY docker docker
COPY docker-compose.yml .env.example README.md CHANGELOG.md ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ARG SS_BUILD_ID
ARG SS_VERSION
ENV NODE_ENV=production
ENV SS_MODE=all-in-one
ENV SERVERSENTINEL_BUILD_ID=${SS_BUILD_ID}
ENV SERVERSENTINEL_DATA_DIR=/data
ENV SERVERSENTINEL_SERVERS_DOCKER_VOLUME=serversentinel-minecraft-servers
ENV SERVERSENTINEL_NODE_IMAGE=nl2109/serversentinel:${SS_VERSION}
ENV PORT=8080

COPY package*.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY --from=production-dependencies /app/node_modules node_modules

COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

EXPOSE 8080
CMD ["node", "server/dist/index.js"]
