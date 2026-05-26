# serverSENTINEL

serverSENTINEL is a Dockerized, single-user WebUI for creating and managing Fabric Minecraft servers.

NOTE: This project is *entirely* coded with AI and it's recommended to only be used in a secure environment.

This MVP intentionally has no authentication, no multi-user model, and no database.

<img width="2652" height="1799" alt="image" src="https://github.com/user-attachments/assets/191c1f82-c15c-4392-a78b-758e5f820fe5" />


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
- Manual mod uploads only accept `.jar` files and write beneath the active server's `mods` folder.
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

If the socket is not mounted, ServerSentinel still works for file creation, files, editing, Modrinth installs, and `logs/latest.log` viewing. Runtime container creation, status, start/stop/restart, Docker logs, overview CPU/memory stats, and console command input require the socket.

## Console Command Input

ServerSentinel sends console commands to managed Minecraft runtime containers by creating a short-lived Docker exec process that writes one command line to `/proc/1/fd/0` inside the runtime container. This is supported for containers created by ServerSentinel because they are configured with `OpenStdin: true`, `AttachStdin: true`, and `Tty: false`.

Command input is intentionally marked unavailable for non-managed containers or containers that were not created with those stdin settings. If Docker cannot write to stdin, the command request fails and the UI shows the error; ServerSentinel does not report command success unless the Docker exec exits successfully. Logs continue to stream from Docker logs or `logs/latest.log` even when command input is unavailable.

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
- No mod dependency/conflict resolver; installs the latest Modrinth version matching Fabric and the selected Minecraft version.
