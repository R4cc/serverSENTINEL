# serverSENTINEL

serverSENTINEL is a web panel for running Minecraft servers with Docker. It gives you a browser-based place to create servers, start and stop them, view the live console, send commands, manage files, install mods, schedule actions, and manage users.

This project is preproduction software. It was written with AI assistance, including later polishing and security hardening passes. That can make development faster, but it does not make the software perfect: AI-written code can still miss edge cases, contain ordinary bugs, or make assumptions that need more real-world testing.

Do not expose the panel directly to the public internet. Use it on a LAN, behind a VPN, through Cloudflare Tunnel, or behind a reverse proxy with strong authentication. Treat panel access, node secrets, Docker access, console access, and file manager access as administrative control over the machines and servers involved.

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
- Browser file editor with line numbers and syntax highlighting for common config files
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

serverSENTINEL stores configuration as JSON files on disk and does not require an external database.

Recommended host folders:

```text
/opt/serversentinel/config
/opt/serversentinel/servers
/opt/serversentinel/data
```

Use `config` for panel settings and users, `servers` for all-in-one managed server files, and `data` for node-managed server files.

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
SERVERSENTINEL_SERVERS_DIR=/data/servers
SERVERSENTINEL_SERVERS_DOCKER_VOLUME=
MODRINTH_API_KEY=
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

## First Run

1. Start the panel.
2. Open `http://localhost:8080` or your configured panel URL.
3. Create the initial admin user when prompted.
4. For panel-only deployments, add a node from the Nodes area and run the generated node command on the Docker host.
5. Create a managed server and start it from the panel.

## Screenshots

Replace these placeholders with real screenshots when ready.

### Overview

![Overview screenshot placeholder](docs/screenshots/overview.png)

Server list, status, and high-level controls.

### Console

![Console screenshot placeholder](docs/screenshots/console.png)

Live output and command input.

### File Manager

![File Manager screenshot placeholder](docs/screenshots/file-manager.png)

Browse, upload, rename, duplicate, download, and delete server files.

### File Editor

![File Editor screenshot placeholder](docs/screenshots/file-editor.png)

Edit text/config files in the browser.

### Mods

![Mods screenshot placeholder](docs/screenshots/mods.png)

View and manage installed mods.

### Mod Installation Flow

![Mod Installation Flow screenshot placeholder](docs/screenshots/mod-installation-flow.png)

Search Modrinth and install compatible mods.

### Nodes

![Nodes screenshot placeholder](docs/screenshots/nodes.png)

View node status and connection state.

### Add Node Flow

![Add Node Flow screenshot placeholder](docs/screenshots/add-node-flow.png)

Create a node join token and copy generated install commands.

### Schedules

![Schedules screenshot placeholder](docs/screenshots/schedules.png)

Create scheduled server actions.

### Settings

![Settings screenshot placeholder](docs/screenshots/settings.png)

Configure panel settings.

### User Management

![User Management screenshot placeholder](docs/screenshots/user-management.png)

Manage local users, roles, and permissions.

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

## Current Limitations

- This is preproduction software.
- Managed server creation is currently focused on Fabric Minecraft servers.
- Managing arbitrary already-running external Minecraft servers is not the primary supported model.
- Modrinth installs target compatible versions, but this is not a full dependency or conflict resolver.
- The Docker socket and node agent model should be treated as trusted administrator access.
