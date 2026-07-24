# serverSENTINEL 1.5.5 Release Smoke Test

This path verifies the 1.5.5 release like an administrator using a fresh instance. Run it on a disposable Linux host or VM with Docker and Docker Compose access. Do not run it against production data.

## Prerequisites

- Docker Engine with permission to mount `/var/run/docker.sock`.
- Ports `8080`, `25565`, and `25566` free on the host.
- A browser with developer tools.
- `sqlite3` installed for the optional database checks.
- A clean checkout of the release candidate.

Set these variables in the checkout:

```bash
export SS_IMAGE=nl2109/serversentinel:1.5.5
export SS_NAME=serversentinel-smoke
export SS_URL=http://127.0.0.1:8080
export SS_SMOKE_ROOT="$(mktemp -d -t serversentinel-smoke-XXXXXX)"
export SS_DATA="$SS_SMOKE_ROOT/data"
export SS_DB="$SS_DATA/serversentinel.sqlite"
export SS_SERVERS_VOLUME=serversentinel-smoke-servers
mkdir -p "$SS_DATA"
```

## Build And Start Fresh

Build the image from the candidate:

```bash
docker build -t "$SS_IMAGE" -f docker/Dockerfile .
```

Start a fresh all-in-one panel with an empty data root:

```bash
docker rm -f "$SS_NAME" 2>/dev/null || true
docker volume rm -f "$SS_SERVERS_VOLUME" 2>/dev/null || true
docker volume create "$SS_SERVERS_VOLUME"
docker run -d \
  --name "$SS_NAME" \
  --restart no \
  -p 8080:8080 \
  -e SS_MODE=all-in-one \
  -e SERVERSENTINEL_DATA_DIR=/data \
  -e SERVERSENTINEL_SERVERS_DOCKER_VOLUME="$SS_SERVERS_VOLUME" \
  -v "$SS_DATA:/data" \
  -v "$SS_SERVERS_VOLUME:/data/servers" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$SS_IMAGE"
```

Expected:

- `docker logs "$SS_NAME"` shows the panel listening on port `8080`.
- Opening `$SS_URL` shows the first-admin setup screen, not demo mode.
- `$SS_DB` exists after startup.

## First Admin Setup

In the browser:

1. Create the first administrator.
2. Log out, then log back in with that account.
3. Refresh the page and confirm the session remains active.

Expected:

- The first user lands in the full admin panel.
- The footer or app metadata reports version `1.5.5`.
- A second browser/incognito window no longer shows first-admin setup.

Optional SQLite check:

```bash
sqlite3 "$SS_DB" "select username, role_preset from users;"
sqlite3 "$SS_DB" "select count(*) from sessions;"
```

Expected: one admin user exists and at least one active session exists.

## Create A Managed Fabric Server

In the Servers area, create a managed server:

- Name: `Smoke Fabric 1.0`
- Node: local/all-in-one node
- Loader: Fabric
- Minecraft and loader versions: current defaults offered by the UI
- EULA: accepted
- Ports: `25565:25565/tcp` and `25566:25566/udp` if the form asks for explicit mappings

Expected:

- Provisioning completes without an error banner.
- The new server appears in the stopped/offline state.
- The server has a generated ID and generated container name.

Verify filesystem and SQLite state:

```bash
docker run --rm -v "$SS_SERVERS_VOLUME:/servers:ro" alpine find /servers -maxdepth 3 -type f | sort
sqlite3 "$SS_DB" "select id, display_name, node_id, container_name from servers;"
sqlite3 "$SS_DB" "select port, protocol from managed_ports order by port;"
```

Expected:

- One generated server directory exists in `$SS_SERVERS_VOLUME`.
- The directory contains `server.properties`, `eula.txt`, and a Fabric runtime jar.
- SQLite contains one server row and the configured port rows.

## Runtime And Console

In the server view:

1. Open the Console tab.
2. Start the server.
3. In browser developer tools, confirm the websocket connects to `/ws/console?serverId=<id>` with status `101`.
4. Wait until Minecraft logs appear in the console.
5. Send `say serverSENTINEL smoke command` from the console input.
6. Restart the server from the runtime controls.
7. Stop the server.

Expected:

- Status changes are reflected in the UI for start, restart, and stop.
- Console frames arrive over the websocket.
- The `say` command appears in console output or `logs/latest.log`.
- Restart does not orphan duplicate containers.

Optional host check:

```bash
docker ps -a --filter "name=serversentinel" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
docker run --rm -v "$SS_SERVERS_VOLUME:/servers:ro" alpine sh -c 'grep -R "serverSENTINEL smoke command" /servers/*/logs/latest.log'
```

## Files And Edit Leases

With the server stopped:

1. Open Files.
2. List the root directory.
3. Preview `server.properties`.
4. Click Edit, change `motd` to `serverSENTINEL 1.0 smoke`, save, and close the editor.
5. Reopen the file and confirm the saved value is present.

Expected:

- File listing works without showing host paths.
- Preview is read-only until an edit lease is acquired.
- Saving succeeds only while the lease is active.

Start the server and repeat the edit attempt for `server.properties`.

Expected:

- The UI blocks editing or saving `server.properties` while running.
- The message is clear that the server must be stopped before changing mods or server properties.

## Mods While Running

With the server running, open Mods and try each visible mod mutation control:

- Upload mod jar
- Install from Modrinth
- Update selected mod
- Remove selected mod
- Safe batch update, if available

Expected:

- Mutation controls are disabled or rejected while the server is running.
- The user-facing reason says the server must be stopped.
- No partial files are written under the server `mods/` directory in `$SS_SERVERS_VOLUME`.

Stop the server before continuing.

## Schedules

Start the server again. In Schedules, create:

- Name: `Smoke say command`
- Cron: the next minute, for example `*/1 * * * *` during the smoke run
- Commands: `say scheduled smoke run`
- Enabled: yes
- Only when no players: no

Wait up to 90 seconds.

Expected:

- A scheduled run appears in the schedule history.
- The run status is success.
- Console output or `logs/latest.log` includes `scheduled smoke run`.

Optional SQLite check:

```bash
sqlite3 "$SS_DB" "select name, enabled, last_status from schedules;"
sqlite3 "$SS_DB" "select schedule_name, status, message from scheduled_runs order by ran_at desc limit 5;"
```

Delete or disable the schedule after the check.

## Export And Import

If the release candidate exposes Export/Import in the UI:

1. Stop the server.
2. Export the instance or the smoke server.
3. Download the export artifact.
4. Start a second fresh panel on port `8081` with a different empty data root.
5. Create its first admin.
6. Import the artifact into the second panel and select its local node.
7. Confirm the imported server appears and can be opened.

Expected:

- Export completes and downloads an artifact.
- Import validation completes before apply.
- The imported server receives a fresh server ID and valid generated paths.
- The second panel can list files for the imported server.

If the UI is not present, verify the same flow through `POST /api/exports`, `GET /api/exports/:operationId/download`, `POST /api/imports/validate`, and `POST /api/imports/apply` using the browser session cookie and `X-Requested-With: XMLHttpRequest`.

## Node Mode Manual Path

Full node-mode automation is intentionally manual for 1.0 because it requires a second trusted Docker context. Verify it on a second Docker host or VM:

1. Start a panel-only container with a fresh data root and no Docker socket mount:

```bash
docker run -d \
  --name serversentinel-smoke-panel \
  --restart no \
  -p 8080:8080 \
  -e SS_MODE=panel \
  -e SERVERSENTINEL_DATA_DIR=/data \
  -v "$SS_SMOKE_ROOT/panel:/data" \
  "$SS_IMAGE"
```

2. Create the first admin in the panel.
3. Open Nodes, create a join token, and copy the generated node command.
4. Run the generated command on the node host, keeping `SERVERSENTINEL_DATA_DIR` and `SERVERSENTINEL_DOCKER_DATA_DIR` mapped to the same host data root.
5. Confirm the node becomes online.
6. Create a Fabric server on that node.
7. Repeat the create, start, console, command, file preview, stopped-only edit, mods-running-blocked, and schedule checks against the remote node.

Expected:

- The join token is single-use or expires after use.
- The node reports online without exposing its secret.
- Generated Docker paths for Minecraft containers point at the node host data root, not the panel data root.

## Cleanup

```bash
docker rm -f "$SS_NAME" serversentinel-smoke-panel serversentinel-node 2>/dev/null || true
docker ps -a --filter "name=serversentinel" --format "{{.Names}}" | xargs -r docker rm -f
docker volume rm -f "$SS_SERVERS_VOLUME" 2>/dev/null || true
rm -rf "$SS_SMOKE_ROOT"
```

## Release Signoff

Record the release candidate, commit SHA, host OS, Docker version, browser, and any deviations. A 1.0 candidate should not ship if any expected result above fails without a documented product decision.
