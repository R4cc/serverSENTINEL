# serverSENTINEL

serverSENTINEL is a web panel for running Minecraft servers with Docker. It gives you a browser-based place to create servers, start and stop them, view the live console, send commands, manage files, install mods, schedule actions, and manage users.

This project is preproduction software. It was written with AI assistance, including later polishing and security hardening passes. That can make development faster, but it does not make the software perfect: AI-written code can still miss edge cases, contain ordinary bugs, or make assumptions that need more real-world testing.

Do not expose the panel directly to the public internet. Use it on a LAN, behind a VPN, through Cloudflare Tunnel, or behind a reverse proxy with strong authentication. Treat panel access, node secrets, Docker access, console access, and file manager access as administrative control over the machines and servers involved.

## Screenshots

Replace these placeholders with real screenshots when ready.

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
      <p align="center">Browse, upload, rename, duplicate, download, and delete server files.</p>
    </td>
  </tr>
  <tr>
    <td valign="top" width="50%">
      <p align="center"><strong>Schedules</strong></p>
      <a href="https://github.com/user-attachments/assets/5fb4095b-e99c-487a-96ee-bb128b7acec6" target="_blank">
        <img src="https://github.com/user-attachments/assets/5fb4095b-e99c-487a-96ee-bb128b7acec6" alt="Schedules" style="max-width: 100%;" />
      </a>
      <p align="center">Create scheduled server actions.</p>
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
      <p align="center"><strong>Mod Management/strong></p>
      <a href="https://github.com/user-attachments/assets/f40728ba-12d9-4755-9734-e1b789dc5ee9" target="_blank">
        <img width="2467" height="2065" alt="image" src="https://github.com/user-attachments/assets/4bfe5ba0-2d32-4b01-bfd6-897a4f5c1ae0" />
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
