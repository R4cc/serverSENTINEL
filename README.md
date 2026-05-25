# ServerSentinel

ServerSentinel is a Dockerized, single-user WebUI for creating and managing Fabric Minecraft servers.

It does not run Minecraft inside the ServerSentinel container. Instead, ServerSentinel creates server folders under its managed server storage and, when Docker integration is enabled, starts a separate Java runtime container per Minecraft server. This follows the same broad shape as panels such as PufferPanel: the panel owns the server definition and orchestrates an isolated runtime.

This MVP intentionally has no authentication, no multi-user model, and no database.

## What Works

Without Docker socket access:

- Create a managed Fabric server folder.
- Download the Fabric server launcher from Fabric's official metadata API.
- Browse files inside managed server directories.
- View and edit UTF-8 text files in the browser.
- Read and stream each server's `logs/latest.log` file.
- Search Modrinth using a server-side `MODRINTH_API_KEY`.
- Install compatible Fabric `.jar` files into the server's `mods` directory.

With Docker socket access:

- Create a separate runtime container for each server.
- Read Minecraft runtime container status.
- Start, stop, and restart the runtime container.
- Read and stream Docker container logs.
- Send Minecraft console commands to a running managed runtime container.

Console command input is available for Docker-managed runtime containers while they are running. Server console commands should be entered without a leading `/`; the UI strips a leading slash if one is typed.

The console input supports common Minecraft server command suggestions, Tab completion, and Up/Down history navigation.

## Runtime Model

ServerSentinel creates server files under `SERVERSENTINEL_SERVERS_DIR`, for example:

```text
/data/servers/survival
```

When Docker control is enabled, it creates a runtime container similar to:

```bash
docker run \
  --name serversentinel-survival \
  -v serversentinel-minecraft-servers:/data/servers \
  -w /data/servers/survival \
  -p 25565:25565 \
  eclipse-temurin:21-jre \
  sh -lc "java -Xms2G -Xmx4G -jar fabric-server-launch.jar nogui"
```

ServerSentinel itself remains only the web panel and orchestrator.

## Safety Boundaries

- Server definitions are persisted in ServerSentinel config storage at `SERVERSENTINEL_CONFIG_DIR`.
- Server files are created under `SERVERSENTINEL_SERVERS_DIR`.
- File operations are scoped to the active managed server directory.
- Requests that try to escape a managed server directory are rejected.
- Mod downloads only write beneath the active server's `mods` folder.
- Browser editing rejects binary files and files larger than 2 MiB.
- `MODRINTH_API_KEY` is read only by the backend and is never sent to the frontend.
- ServerSentinel does not require Java and does not execute Minecraft inside its own container.

## Environment

Copy `.env.example` to `.env` and adjust values as needed:

```env
SERVERSENTINEL_CONFIG_DIR=/config
SERVERSENTINEL_SERVERS_DIR=/data/servers
SERVERSENTINEL_SERVERS_DOCKER_VOLUME=serversentinel-minecraft-servers
MODRINTH_API_KEY=
PORT=8080
```

`SERVERSENTINEL_SERVERS_DOCKER_VOLUME` should match the Docker volume mounted into ServerSentinel at `SERVERSENTINEL_SERVERS_DIR`. This lets runtime containers mount the same volume by name.

## Docker Socket Security

Mounting `/var/run/docker.sock` gives ServerSentinel powerful control over Docker on the host. Treat it as trusted-admin access. Only enable it in local or otherwise trusted environments.

If the socket is not mounted, ServerSentinel still works for file creation, files, editing, Modrinth installs, and `logs/latest.log` viewing. Runtime container creation, status, start/stop/restart, Docker logs, and console command input require the socket.

## Docker

Build and run:

```bash
docker compose up --build
```

Open `http://localhost:8080`.

For Portainer or any host where you pull the published image instead of building from source, use:

```yaml
services:
  serversentinel:
    image: nl2109/serversentinel:latest
    container_name: serversentinel
    ports:
      - "8085:8080"
    environment:
      SERVERSENTINEL_CONFIG_DIR: /config
      SERVERSENTINEL_SERVERS_DIR: /data/servers
      SERVERSENTINEL_SERVERS_DOCKER_VOLUME: serversentinel-minecraft-servers
      PORT: 8080
      MODRINTH_API_KEY: ${MODRINTH_API_KEY:-}
    volumes:
      - serversentinel-config:/config
      - minecraft-servers:/data/servers
      - /var/run/docker.sock:/var/run/docker.sock
    restart: unless-stopped

volumes:
  serversentinel-config:
  minecraft-servers:
    name: serversentinel-minecraft-servers
```

To enable Docker-managed runtime creation/status/control/logs, uncomment this volume in `docker-compose.yml`:

```yaml
- /var/run/docker.sock:/var/run/docker.sock
```

## Docker Hub Publishing

The GitHub Actions workflow in `.github/workflows/dockerpush.yml` builds and pushes `nl2109/serversentinel` when changes land on `main`.

Configure these GitHub repository secrets before pushing:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

Pull the published image with:

```bash
docker pull nl2109/serversentinel:latest
```

## Development

Install dependencies:

```bash
npm install
```

Run the backend and frontend in separate terminals:

```bash
npm run dev:server
npm run dev:web
```

For local development outside Docker, set `SERVERSENTINEL_CONFIG_DIR` and `SERVERSENTINEL_SERVERS_DIR` to writable local folders.

The Vite dev server proxies `/api` and `/ws` to the backend on port `8080`.

Build everything:

```bash
npm run build
```

## Current MVP Limitations

- No authentication. Do not expose this service directly to the public internet.
- Server creation is Fabric-only.
- No mod dependency/conflict resolver; installs the latest Modrinth version matching Fabric and the requested Minecraft version.
