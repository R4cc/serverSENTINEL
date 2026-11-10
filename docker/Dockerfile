# syntax=docker/dockerfile:1

ARG SS_VERSION=26.11.4
FROM node:22-bookworm-slim AS dependency-base

WORKDIR /app

FROM alpine:3.22 AS tcp-rtt-probe-build

RUN apk add --no-cache build-base linux-headers
COPY server/native/tcp-rtt-probe.c /src/tcp-rtt-probe.c
RUN cc -static -Os -s -Wall -Wextra -Werror -o /tcp-rtt-probe /src/tcp-rtt-probe.c \
  && /tcp-rtt-probe --self-test

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

# Published packages also carry their own test suites, docs, source maps and type declarations,
# which is about half of the production tree and nothing the server loads. A test or docs folder
# is removed only directly inside a package (beside its package.json), so a runtime module that
# merely happens to be called `test` deeper in a package's code is left alone. Licenses stay.
RUN find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs \
      -o -name example -o -name examples -o -name bench -o -name benchmark -o -name benchmarks -o -name .github \) \
      -prune -exec sh -c 'test -f "$1/../package.json" && rm -rf "$1"' sh {} \; \
  && find node_modules -type f \( -name '*.map' -o -name '*.ts' -o -name '*.mts' -o -name '*.cts' \
      -o \( -iname '*.md' ! -iname 'licen[cs]e*' \) \) -delete \
  && node -e "for (const name of Object.keys(require('./server/package.json').dependencies)) if (!name.startsWith('@serversentinel/')) require(name)"

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
COPY --from=tcp-rtt-probe-build /tcp-rtt-probe server/native/tcp-rtt-probe

RUN ["/nodejs/bin/node", "-e", "const fs = require('node:fs'); const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.exec('SELECT 1'); db.close(); new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Vienna' }).format(new Date()); if (typeof fetch !== 'function' || !fs.existsSync(process.env.SSL_CERT_FILE)) process.exit(1)"]

EXPOSE 8080
CMD ["server/dist/index.js"]
