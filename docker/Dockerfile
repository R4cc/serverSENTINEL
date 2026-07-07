FROM node:22-bookworm-slim AS build

WORKDIR /app
ARG VITE_ENABLE_DEMO=false
ENV VITE_ENABLE_DEMO=${VITE_ENABLE_DEMO}

COPY package*.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY server server
COPY web web
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ARG SS_BUILD_ID
ENV NODE_ENV=production
ENV SS_MODE=all-in-one
ENV SERVERSENTINEL_BUILD_ID=${SS_BUILD_ID}
ENV SERVERSENTINEL_DATA_DIR=/data
ENV SERVERSENTINEL_SERVERS_DOCKER_VOLUME=serversentinel-minecraft-servers
ENV SERVERSENTINEL_NODE_IMAGE=nl2109/serversentinel:1.0.0
ENV PORT=8080

COPY package*.json ./
COPY server/package.json server/package.json
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --workspace server; else npm install --omit=dev --workspace server; fi

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

EXPOSE 8080
CMD ["node", "server/dist/index.js"]
