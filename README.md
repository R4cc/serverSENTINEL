# ServerSentinel

ServerSentinel is a Dockerized web panel for creating and managing Fabric Minecraft managed server instances.

NOTE: This project is *entirely* coded with AI and it's recommended to only be used in a secure environment.

ServerSentinel stores its lightweight configuration, users, and managed server definitions on disk. It does not require an external database.

<img width="2652" height="1799" alt="image" src="https://github.com/user-attachments/assets/191c1f82-c15c-4392-a78b-758e5f820fe5" />


## Runtime Model

ServerSentinel is a web panel and orchestrator. Minecraft runs only in separate Minecraft runtime containers created for managed server instances, never in the web panel container. Managing arbitrary existing or already-running external Minecraft servers is not supported.

The supported model is:

1. ServerSentinel creates a managed server instance.
2. ServerSentinel writes the managed server files under `SERVERSENTINEL_SERVERS_DIR`, for example:

```text
/data/servers/survival
```

3. With Docker integration enabled, ServerSentinel launches a separate Minecraft runtime container for that managed server instance, similar to:

```bash
docker run \
  --name serversentinel-survival \
  -v serversentinel-minecraft-servers:/data/servers \
  -w /data/servers/survival \
  -p 25565:25565 \
  eclipse-temurin:21-jre \
  sh -lc "java -Xms2G -Xmx4G -jar fabric-server-launch.jar nogui"
```

Each managed server instance has its own managed server files and Minecraft runtime container. ServerSentinel remains only the ServerSentinel web panel and orchestrator.

## Safety Boundaries

- Server definitions are persisted in ServerSentinel config storage at `SERVERSENTINEL_CONFIG_DIR`.
- Users have role presets and explicit permissions. Backend authorization checks permissions, not role names.
- Server files are created under `SERVERSENTINEL_SERVERS_DIR`.
- File operations are scoped to the active managed server directory.
- Requests that try to escape a managed server directory are rejected.
- Mod downloads only write beneath the active server's `mods` folder.
- Manual mod uploads only accept `.jar` files and write beneath the active server's `mods` folder.
- Browser editing rejects binary files and files larger than 2 MiB.
- `MODRINTH_API_KEY` is read only by the backend and is never sent to the frontend.
- ServerSentinel does not require Java and does not execute Minecraft inside the web panel container.

## Environment

Copy `.env.example` to `.env` and adjust values as needed:

```env
SERVERSENTINEL_CONFIG_DIR=/config
SERVERSENTINEL_SERVERS_DIR=/data/servers
SERVERSENTINEL_SERVERS_DOCKER_VOLUME=serversentinel-minecraft-servers
MODRINTH_API_KEY=
LOG_LEVEL=info
PORT=8080
```

`SERVERSENTINEL_SERVERS_DOCKER_VOLUME` should match the Docker volume mounted into ServerSentinel at `SERVERSENTINEL_SERVERS_DIR`. This lets Minecraft runtime containers mount the same managed server files by name.

## Docker Socket Security

Mounting `/var/run/docker.sock` gives ServerSentinel powerful control over Docker on the host. Treat it as trusted-admin access. Only enable it in local or otherwise trusted environments.

Docker socket access is required for creating Minecraft runtime containers, starting, stopping, restarting, Docker logs, overview CPU/memory stats, and console command input. If the socket is not mounted, ServerSentinel can still prepare managed server files, but runtime management is unavailable.

## ServerSentinel Application Logs

ServerSentinel writes its own backend/application logs to stdout and stderr, so they appear in Docker logs:

```bash
docker logs -f serversentinel
```

Use `LOG_LEVEL` to control verbosity. The default is `info`; set `LOG_LEVEL=debug` only while diagnosing noisy details.

Application logs are structured JSON and focus on operational events such as startup configuration, Docker integration availability, managed server provisioning, runtime container start/stop/restart, file writes/deletes, Modrinth search/install, manual mod uploads, schedule execution, authentication/user actions, API errors, and console log streaming failures.

Secrets are intentionally excluded. ServerSentinel does not log Modrinth API keys, passwords, full request bodies for sensitive endpoints, uploaded file contents, full Minecraft console logs, or full mod download URLs.

## Console Command Input

ServerSentinel sends console commands to managed Minecraft runtime containers by creating a short-lived Docker exec process that writes one command line to `/proc/1/fd/0` inside the runtime container. This is supported for Minecraft runtime containers created by ServerSentinel because they are configured with `OpenStdin: true`, `AttachStdin: true`, and `Tty: false`.

Command input is intentionally marked unavailable for non-managed containers or containers that were not created with those stdin settings. Managing already-running external Minecraft servers is not supported. If Docker cannot write to stdin, the command request fails and the UI shows the error; ServerSentinel does not report command success unless the Docker exec exits successfully. Logs continue to stream from Docker logs or `logs/latest.log` even when command input is unavailable.

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

To enable Docker integration for runtime container creation, status, start/stop/restart, logs, stats, and console command input, uncomment this volume in `docker-compose.yml`:

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

- Authentication is local and permission-based, but the Docker socket still grants powerful host access. Do not expose this service directly to the public internet.
- Managed server creation is Fabric-only.
- Managing arbitrary existing or already-running external Minecraft servers is not supported.
- No mod dependency/conflict resolver; installs the latest Modrinth version matching Fabric and the selected Minecraft version.
