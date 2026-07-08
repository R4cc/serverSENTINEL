# serverSENTINEL 1.0.2 Release Notes

serverSENTINEL 1.0.2 is the current stable release line for the Docker-based Minecraft server panel.

## Upgrade From 0.8.x

- Back up the full `SERVERSENTINEL_DATA_DIR` before upgrading. Include `serversentinel.sqlite`, any adjacent SQLite `-wal` and `-shm` files, `servers/`, and any export or backup artifacts you rely on.
- Keep the same data root and server-file mount model. The recommended 1.0 all-in-one setup uses the `serversentinel-minecraft-servers` named volume mounted at `/data/servers`; advanced host-bind deployments must keep the same host path visible to the Docker daemon.
- Upgrade the panel and all node agents to `nl2109/serversentinel:1.0.2`. Mixed panel/node versions are intended only as a short upgrade window.
- No manual SQLite migration command is required for 0.8.x data roots.
- Pre-0.8 JSON configuration files are not imported by 1.0. Move those installs through 0.8.x first or create a fresh 1.0 data root.

## Notable 1.0 Behavior

- The runtime data root is controlled by `SERVERSENTINEL_DATA_DIR`; the default container path is `/data`.
- Demo mode is off by default and requires both `VITE_ENABLE_DEMO=true` at frontend build time and `SERVERSENTINEL_ENABLE_DEMO=true` at backend runtime.
- `SS_MODE` selects the runtime role: `all-in-one`, `panel`, or `node`.
- Node agents require `SS_PANEL_URL` and `SERVERSENTINEL_DOCKER_DATA_DIR` so sibling Minecraft containers can mount the correct host-side data path.
- The published Docker workflow tags main builds as `latest`, `1.0.2`, and the commit SHA.

## Deployment Reminder

Do not expose the panel directly to the public internet. Use a LAN, VPN, tunnel, or reverse proxy with strong authentication, and treat Docker socket access as administrative access to the host.
