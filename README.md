# serverSENTINEL

serverSENTINEL is a web panel for running and managing Minecraft servers and their mods with Docker. It provides a browser-based interface for handling the parts of server administration that would normally require SSH, Docker commands, editing configuration files manually, or separate tools like FileZilla and other file transfer clients.

## Features

* Create and configure Minecraft servers
* Start, stop, and restart servers
* Search for and install mods through the Modrinth API
* Get notified when a *compatible* mod update is available and update in one click
* View the live console and send commands
* Browse, upload, edit, and manage server files
* Add existing mod files and manage installed mods
* Schedule commands and server actions
* Manage multiple nodes from one panel
* Manage users, roles, and permissions
* Monitor server status and resource usage

A large part of serverSENTINEL was written with the help of AI, which made it possible to scale the project and accelerate development far beyond what I could have done on my own. The AI-generated code has gone through extensive cleanup, testing, review, and polish passes. The priority throughout development has been to make the underlying systems work reliably and predictably.

## Security

serverSENTINEL should be treated as an administrative tool. Access to the panel may provide control over Docker containers, server consoles, files, node secrets, and the machines hosting them.

I recommend to keep the panel isolated and not make it directly exposed to the public internet. If you want to use remote access, I would access it using a VPN, through Cloudflare Tunnel, or behind a reverse proxy with strong authentication.


## Screenshots

<table>
  <tr>
    <td valign="top" width="50%">
      <p align="center"><strong>Overview</strong></p>
      <a href="docs/screenshots/overview.png">
        <img width="1440" height="1000" alt="serverSENTINEL server overview" src="docs/screenshots/overview.png" style="max-width: 100%;" />
      </a>
      <p align="center">Server list, status, and high-level controls.</p>
    </td>
    <td valign="top" width="50%">
      <p align="center"><strong>Console</strong></p>
      <a href="docs/screenshots/console.png">
        <img width="1440" height="1000" alt="serverSENTINEL live server console" src="docs/screenshots/console.png" style="max-width: 100%;" />
      </a>
      <p align="center">Live output and command input.</p>
    </td>
  </tr>
  <tr>
    <td valign="top" width="50%">
      <p align="center"><strong>File Manager</strong></p>
      <a href="docs/screenshots/files.png">
        <img width="1440" height="1000" alt="serverSENTINEL file manager" src="docs/screenshots/files.png" style="max-width: 100%;" />
      </a>
      <p align="center">Browse and manage server files.</p>
    </td>
    <td valign="top" width="50%">
      <p align="center"><strong>File Editor</strong></p>
      <a href="docs/screenshots/file-editor.png">
        <img width="1440" height="1000" alt="serverSENTINEL file editor" src="docs/screenshots/file-editor.png" style="max-width: 100%;" />
      </a>
      <p align="center">Edit server configuration and text files safely.</p>
    </td>
  </tr>
  <tr>
    <td valign="top" width="50%">
      <p align="center"><strong>Mod Management</strong></p>
      <a href="docs/screenshots/mods.png">
        <img width="1440" height="1000" alt="serverSENTINEL mod management" src="docs/screenshots/mods.png" style="max-width: 100%;" />
      </a>
      <p align="center">Manage server mods and updates.</p>
    </td>
    <td valign="top" width="50%">
      <p align="center"><strong>Schedules</strong></p>
      <a href="docs/screenshots/schedules.png">
        <img width="1440" height="1000" alt="serverSENTINEL schedules" src="docs/screenshots/schedules.png" style="max-width: 100%;" />
      </a>
      <p align="center">Create and edit scheduled server actions.</p>
    </td>
  </tr>
  <tr>
    <td valign="top" width="50%">
      <p align="center"><strong>Server Properties</strong></p>
      <a href="docs/screenshots/properties.png">
        <img width="1440" height="1000" alt="serverSENTINEL server properties" src="docs/screenshots/properties.png" style="max-width: 100%;" />
      </a>
      <p align="center">Review and update server configuration.</p>
    </td>
    <td valign="top" width="50%">
      <p align="center"><strong>Settings</strong></p>
      <a href="docs/screenshots/settings.png">
        <img width="1440" height="1000" alt="serverSENTINEL settings" src="docs/screenshots/settings.png" style="max-width: 100%;" />
      </a>
      <p align="center">Configure panel settings.</p>
    </td>
  </tr>
  <tr>
    <td valign="top" colspan="2">
      <p align="center"><strong>Dark Mode</strong></p>
      <a href="docs/screenshots/overview-dark.png">
        <img width="1440" height="1000" alt="serverSENTINEL server overview in dark mode" src="docs/screenshots/overview-dark.png" style="max-width: 100%;" />
      </a>
      <p align="center">The full interface is also available in dark mode.</p>
    </td>
  </tr>
</table>


## How It Works

The panel provides the web interface and API. It can manage Docker on the same host or connect to node agents on other Docker hosts. Each Minecraft server runs in its own container rather than inside the panel container.

For a single machine, use the included all-in-one Docker Compose setup. For multiple machines, run the panel in `panel` mode, add nodes from the web interface, and use the generated install command on each host.

## Quick Start

Docker Engine with Docker Compose is required. Clone the repository and start the included all-in-one setup:

```bash
git clone https://github.com/R4cc/serverSENTINEL.git
cd serverSENTINEL
docker compose up -d
```

Open `http://localhost:8080`. On first launch, get the one-time setup token from the container log and use it to create the administrator account:

```bash
docker compose logs serversentinel
```

The defaults work as-is. To customize the port, time zone, image, or optional API settings, copy [`.env.example`](.env.example) to `.env` before starting the container.

## First Run

1. Create the initial administrator with the setup token.
2. Create and configure a Minecraft server.
3. Start it and follow its progress from the live console.

To manage additional Docker hosts, open the Nodes area, add a node, and run the command generated by the panel on that host.

## Development

```bash
npm install
npm run dev:server
npm run dev:web
```

Run the backend and frontend development commands in separate terminals. Before submitting changes, run:

```bash
npm test
npm run typecheck
npm run build
```

## Known Limitations

- Server creation is currently focused on Fabric.
- Existing external Minecraft servers are not the primary management model.
- Modrinth integration does not fully resolve mod dependencies or conflicts.

See [CHANGELOG.md](CHANGELOG.md) for release history. serverSENTINEL is licensed under the [Apache License 2.0](LICENSE).
