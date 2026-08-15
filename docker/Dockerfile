# syntax=docker/dockerfile:1

ARG SS_VERSION=26.8.17
FROM node:22-bookworm-slim AS dependency-base

WORKDIR /app

FROM dependency-base AS production-dependencies

COPY package*.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
RUN --mount=type=cache,id=serversentinel-npm,target=/root/.npm \
  npm ci --ignore-scripts --omit=dev --workspace server \
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
RUN --mount=type=cache,id=serversentinel-npm,target=/root/.npm npm ci --ignore-scripts

COPY shared shared
COPY server server
COPY web web
COPY scripts scripts
COPY docker docker
COPY docker-compose.yml .env.example README.md CHANGELOG.md ./
RUN npm run build

FROM gcr.io/distroless/nodejs22-debian13:latest AS runtime

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

RUN ["/nodejs/bin/node", "-e", "const fs = require('node:fs'); const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.exec('SELECT 1'); db.close(); new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Vienna' }).format(new Date()); if (typeof fetch !== 'function' || !fs.existsSync(process.env.SSL_CERT_FILE)) process.exit(1)"]

EXPOSE 8080
CMD ["server/dist/index.js"]
