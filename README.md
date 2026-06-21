# serverSENTINEL

serverSENTINEL is a web panel for running Minecraft servers with Docker. It gives you a browser-based place to create servers, start and stop them, view the live console, send commands, manage files, install mods, schedule actions, and manage users.

This project is preproduction software. Test it on non-critical servers first, keep backups, and review your deployment settings before trusting it with production worlds or public access.

Do not expose the panel directly to the public internet. Use it on a LAN, behind a VPN, through Cloudflare Tunnel, or behind a reverse proxy with strong authentication. Treat panel access, node secrets, Docker access, console access, and file manager access as administrative control over the machines and servers involved.

## Screenshots

<table>
  <tr>
    <td valign="top" width="50%">
      <p align="center"><strong>Overview</strong></p>
      <a href="https://github.com/user-attachments/assets/6924c2d5-e579-4f0c-9937-a40ce735eb44" target="_blank">
        <img src="https://github.com/user-attachments/assets/6924c2d5-e579-4f0c-9937-a40ce735eb44" alt="Overview" style="max-width: 100%;" />
      </a>
      <p align="center">Server list, status, and high-level controls.</p>
    </td>
    <td valign="top" width="50%">
      <p align="center"><strong>Console</strong></p>
      <a href="https://github.com/user-attachments/assets/e9336787-809c-4adb-a817-767ce91f1335" target="_blank">
        <img src="https://github.com/user-attachments/assets/e9336787-809c-4adb-a817-767ce91f1335" alt="Console" style="max-width: 100%;" />
      </a>
      <p align="center">Live output and command input.</p>
    </td>
  </tr>
  <tr>
    <td valign="top" width="50%">
      <p align="center"><strong>File Manager</strong></p>
      <a href="https://github.com/user-attachments/assets/09511dc4-b108-4019-917d-f33c31935111" target="_blank">
        <img src="https://github.com/user-attachments/assets/09511dc4-b108-4019-917d-f33c31935111" alt="File Manager" style="max-width: 100%;" />
      </a>
      <p align="center">Edit text/config files in the browser.</p>
    </td>
    <td valign="top" width="50%">
      <p align="center"><strong>File Editor</strong></p>
      <a href="https://github.com/user-attachments/assets/9de7d244-fe6a-443c-8a71-b9fe690d7960" target="_blank">
        <img src="https://github.com/user-attachments/assets/9de7d244-fe6a-443c-8a71-b9fe690d7960" alt="File Editor" style="max-width: 100%;" />
      </a>
      <p align="center">Edit server configuration and text files safely.</p>
    </td>
  </tr>
  <tr>
    <td valign="top" width="50%">
      <p align="center"><strong>Schedules</strong></p>
      <a href="https://github.com/user-attachments/assets/5fb4095b-e99c-487a-96ee-bb128b7acec6" target="_blank">
        <img src="https://github.com/user-attachments/assets/5fb4095b-e99c-487a-96ee-bb128b7acec6" alt="Schedules" style="max-width: 100%;" />
      </a>
      <p align="center">Create and edit scheduled server actions.</p>
    </td>
    <td valign="top" width="50%">
      <p align="center"><strong>Settings</strong></p>
      <a href="https://github.com/user-attachments/assets/e33bfbe9-5b3a-4e4e-9a7e-ebff2c56c73d" target="_blank">
        <img src="https://github.com/user-attachments/assets/e33bfbe9-5b3a-4e4e-9a7e-ebff2c56c73d" alt="Settings" style="max-width: 100%;" />
      </a>
      <p align="center">Configure panel settings.</p>
    </td>
  </tr>
  <tr>
    <td valign="top" width="50%">
      <p align="center"><strong>User Management</strong></p>
      <a href="https://github.com/user-attachments/assets/f40728ba-12d9-4755-9734-e1b789dc5ee9" target="_blank">
        <img src="https://github.com/user-attachments/assets/f40728ba-12d9-4755-9734-e1b789dc5ee9" alt="User Management" style="max-width: 100%;" />
      </a>
      <p align="center">Manage local users, roles, and permissions.</p>
    </td>
    <td valign="top" width="50%">
      <p align="center"><strong>Mod Management</strong></p>
      <a href="https://github.com/user-attachments/assets/4bfe5ba0-2d32-4b01-bfd6-897a4f5c1ae0" target="_blank">
        <img src="https://github.com/user-attachments/assets/4bfe5ba0-2d32-4b01-bfd6-897a4f5c1ae0" alt="Mod Management" style="max-width: 100%;" />
      </a>
      <p align="center">Manage server mods and updates.</p>
    </td>
  </tr>
</table>


## How It Works

serverSENTINEL has two runtime roles:

- **Panel**: the web UI and API. It stores users, settings, node definitions, and server metadata.
- **Node agent**: a host-side agent that connects back to the panel and performs Docker, console, file, mod, and server operations on its own machine.

The panel can manage servers across one or more nodes. In multi-host setups, each node is responsible for Docker operations on the host where it runs. A panel-only container should not need direct Docker socket access when all server operations are handled by remote node agents.

Supported modes:

- **All-in-one / local node**: the panel and local Docker management run on the same host. This is the recommended setup for simple single-host use.
- **Panel**: runs only the web panel. Use this for multi-host setups where separate node agents manage servers.
- **Node**: runs only a node agent. Use this on each Docker host that should run Minecraft servers.

Minecraft itself does not run inside the panel container. Managed Minecraft servers run as separate Docker containers created and controlled by serverSENTINEL.

## Features

- Server overview with status and runtime information
- Docker-based server creation and management
- Start, stop, and restart controls
- Live console output
- Console command input
- File manager
- Browser file editor with read-only viewing, exclusive edit leases, revision checks, line numbers, and syntax highlighting
- Modrinth search and install flow
- Mod upload and management
- Schedules
- Settings
- Local user management and permissions
- Multi-node management
- Add node flow with generated install commands
- Node connection and status handling

## Safety Notes

- Do not expose the panel directly to the public internet.
- Prefer LAN-only access, a VPN, Cloudflare Tunnel, or a reverse proxy with additional authentication.
- Protect API keys, node join tokens, node secrets, user passwords, and Docker socket access.
- Docker socket access is powerful. A container with access to `/var/run/docker.sock` can control Docker on the host.
- File manager and console access are powerful administrative features. Give those permissions only to users you trust.
- Keep backups of your config and server folders before upgrading or testing major changes.

## Storage

ServerSentinel 0.8.0 stores panel state in a local SQLite database. Users, sessions, settings, nodes, managed servers, ports, schedules, scheduled runs, resource-stat history, mod preferences, and file edit leases are stored there. No external database service is required.

The default database path is:

```text
/config/serversentinel.sqlite
```

Set `SERVERSENTINEL_DATABASE_PATH` to override it. Relative values are resolved from the process working directory, so an absolute path is recommended. The parent directory is created automatically.

Version 0.8.0 is a breaking preproduction release. Existing `users.json`, `nodes.json`, `servers.json`, and settings JSON files are not read, imported, or migrated. A fresh database starts with empty panel state and prompts for initial setup.

Back up the SQLite database together with your Minecraft server folders. The simplest reliable file-copy backup is to stop the panel, copy `serversentinel.sqlite` (and any adjacent `-wal`/`-shm` files if present), then restart it. Files inside managed Minecraft server directories remain separate from the panel database and need their own backups.

The file editor opens files read-only. Entering edit mode acquires a short-lived exclusive lease for that server/path while other users can continue viewing it. Active editors heartbeat the lease, stale leases expire automatically, and saving is rejected if the file changed outside ServerSentinel after edit mode began.

Recommended host folders:

```text
/opt/serversentinel/config
/opt/serversentinel/servers
/opt/serversentinel/data
```

Use `config` for the panel SQLite database, `servers` for all-in-one managed server files, and `data` for node-managed server files.

## Deployment

The published image used by the project is:

```text
nl2109/serversentinel:latest
```

The panel listens on port `8080` inside the container.

### All-In-One With Docker Run

Use this for a simple single-host setup.

```bash
sudo mkdir -p /opt/serversentinel/config /opt/serversentinel/servers

docker run -d \
  --name serversentinel \
  --restart unless-stopped \
  -p 8080:8080 \
  -e SS_MODE=all-in-one \
  -e PORT=8080 \
  -e SERVERSENTINEL_CONFIG_DIR=/config \
  -e SERVERSENTINEL_SERVERS_DIR=/data/servers \
  -e SERVERSENTINEL_SERVERS_DOCKER_VOLUME= \
  -e MODRINTH_API_KEY= \
  -v /opt/serversentinel/config:/config \
  -v /opt/serversentinel/servers:/data/servers \
  -v /var/run/docker.sock:/var/run/docker.sock \
  nl2109/serversentinel:latest
```

Open:

```text
http://localhost:8080
```

### All-In-One With Docker Compose

```yaml
services:
  serversentinel:
    image: nl2109/serversentinel:latest
    container_name: serversentinel
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      SS_MODE: all-in-one
      PORT: 8080
      SERVERSENTINEL_CONFIG_DIR: /config
      SERVERSENTINEL_SERVERS_DIR: /data/servers
      SERVERSENTINEL_SERVERS_DOCKER_VOLUME: ""
      MODRINTH_API_KEY: ${MODRINTH_API_KEY:-}
    volumes:
      - /opt/serversentinel/config:/config
      - /opt/serversentinel/servers:/data/servers
      - /var/run/docker.sock:/var/run/docker.sock
```

Start it:

```bash
docker compose up -d
```

### Panel-Only With Docker Run

Use this when one or more separate node agents will manage Docker hosts. This mode does not need the Docker socket mounted into the panel container.

```bash
sudo mkdir -p /opt/serversentinel/config

docker run -d \
  --name serversentinel-panel \
  --restart unless-stopped \
  -p 8080:8080 \
  -e SS_MODE=panel \
  -e PORT=8080 \
  -e SERVERSENTINEL_CONFIG_DIR=/config \
  -v /opt/serversentinel/config:/config \
  nl2109/serversentinel:latest
```

### Panel-Only With Docker Compose

```yaml
services:
  serversentinel-panel:
    image: nl2109/serversentinel:latest
    container_name: serversentinel-panel
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      SS_MODE: panel
      PORT: 8080
      SERVERSENTINEL_CONFIG_DIR: /config
    volumes:
      - /opt/serversentinel/config:/config
```

### Node Agent With Docker Run

In normal use, create a node from the panel's Add Node flow and use the generated command. The command includes a join token and the panel URL.

Template:

```bash
sudo mkdir -p /opt/serversentinel/data

docker run -d \
  --name serversentinel-node \
  --restart unless-stopped \
  -e SS_MODE=node \
  -e SS_PANEL_URL=http://panel-host:8080 \
  -e SS_NODE_NAME=mc-node-01 \
  -e SS_JOIN_TOKEN=PASTE_JOIN_TOKEN_FROM_PANEL \
  -e SS_NODE_DATA_DIR=/data \
  -e SS_NODE_DOCKER_DATA_DIR=/opt/serversentinel/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/serversentinel/data:/data \
  nl2109/serversentinel:latest
```

The node does not publish a web port. It connects outbound to the panel.

### Node Agent With Docker Compose

```yaml
services:
  serversentinel-node:
    image: nl2109/serversentinel:latest
    container_name: serversentinel-node
    restart: unless-stopped
    environment:
      SS_MODE: node
      SS_PANEL_URL: http://panel-host:8080
      SS_NODE_NAME: mc-node-01
      SS_JOIN_TOKEN: PASTE_JOIN_TOKEN_FROM_PANEL
      SS_NODE_DATA_DIR: /data
      SS_NODE_DOCKER_DATA_DIR: /opt/serversentinel/data
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /opt/serversentinel/data:/data
```

## Environment Reference

Common panel variables:

```env
SS_MODE=all-in-one
PORT=8080
SERVERSENTINEL_CONFIG_DIR=/config
SERVERSENTINEL_DATABASE_PATH=/config/serversentinel.sqlite
SERVERSENTINEL_SERVERS_DIR=/data/servers
SERVERSENTINEL_SERVERS_DOCKER_VOLUME=
SERVERSENTINEL_NODE_IMAGE=nl2109/serversentinel:latest
MODRINTH_API_KEY=
MCJARS_BASE_URL=https://mcjars.app
MCJARS_API_KEY=
LOG_LEVEL=info
```

Node variables:

```env
SS_MODE=node
SS_PANEL_URL=http://panel-host:8080
SS_NODE_NAME=mc-node-01
SS_JOIN_TOKEN=PASTE_JOIN_TOKEN_FROM_PANEL
SS_NODE_DATA_DIR=/data
SS_NODE_DOCKER_DATA_DIR=/opt/serversentinel/data
```

`SERVERSENTINEL_SERVERS_DOCKER_VOLUME` can be left empty when using host bind mounts. If it is set to a Docker volume name, serverSENTINEL will use that named volume for Minecraft runtime container mounts instead.

`SERVERSENTINEL_DATABASE_PATH` overrides the panel SQLite file location. Keep it on persistent local storage and include it in backups. It is only used by panel and all-in-one modes.

`SERVERSENTINEL_NODE_IMAGE` controls the image tag shown in generated node update/install instructions. Keep panel and node agent image tags on the same release unless you are deliberately testing a mixed-version upgrade.

`MCJARS_BASE_URL` controls the Fabric server jar/version provider used when resolving runtime profiles for new servers. `MCJARS_API_KEY` is optional; the public MCJars API does not currently require it, but private or future deployments can provide one and ServerSentinel will send it as a bearer token.

Join tokens generated by the panel are short-lived bootstrap secrets. Rotate the token from the Nodes page if a generated command is exposed, expires, or is no longer needed.

## First Run

1. Start the panel.
2. Open `http://localhost:8080` or your configured panel URL.
3. Create the initial admin user when prompted.
4. For panel-only deployments, add a node from the Nodes area and run the generated node command on the Docker host.
5. Create a managed server and start it from the panel.

## Development

Install dependencies:

```bash
npm install
```

Run backend and frontend development servers:

```bash
npm run dev:server
npm run dev:web
```

The Vite dev server proxies `/api` and `/ws` to the backend on port `8080`.

Build all workspaces:

```bash
npm run build
```

Run server tests:

```bash
npm test
```

Run all workspace typechecks:

```bash
npm run typecheck
```

Build the Docker image locally:

```bash
docker build -t nl2109/serversentinel:latest -f docker/Dockerfile .
```

## Current Limitations

- This is preproduction software.
- Managed server creation is currently focused on Fabric Minecraft servers.
- Managing arbitrary already-running external Minecraft servers is not the primary supported model.
- Modrinth installs target compatible versions, but this is not a full dependency or conflict resolver.
- The Docker socket and node agent model should be treated as trusted administrator access.
