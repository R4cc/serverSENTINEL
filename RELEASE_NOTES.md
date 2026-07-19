# serverSENTINEL Release Notes

## Protocol 3.1 Panel-First Rollout

Upgrade the panel before the nodes. The upgraded panel operates protocol 3.1 nodes in current mode, keeps protocol 3.0 nodes fully usable through their legacy commands, and accepts protocol 2.0 nodes only long enough to invoke node self-update. Upgrade protocol 3.0 nodes when practical to enable batched monitoring, cancellation, heartbeat enforcement, and streamed binary transfers.

Protocol 3.1 limits JSON control frames to 8 MiB, active commands to 64, ordinary streams to 32, binary transfers to four, observation batches to 32 servers, and binary chunks to 256 KiB. Regular file uploads remain limited to 32 MiB and managed mod/plugin uploads to 128 MiB. The configured panel download limit applies to remote downloads. Protocol 3.0 JSON/base64 transfers above 72 MiB are rejected with an update-required error before they can approach the WebSocket message limit.

The existing JSON upload request bodies and download URLs remain compatible. The bundled web client now uses multipart uploads, and the panel streams multipart file parts into local temporary sibling files or protocol 3.1 binary transfers. Uploads are committed by atomic rename only after size, type, and SHA-256 checks pass; partial data is removed after cancellation, disconnect, failure, or shutdown.

See [Panel-node protocol](docs/panel-node-protocol.md) for the wire contract and rollout behavior.

## Historical 1.3.0 Database Notes

serverSENTINEL 1.3.0 removes compatibility representations that are no longer needed once the panel and nodes have reached the 1.2.1 baseline.

## Mandatory Database Upgrade Path

- Back up the complete `SERVERSENTINEL_DATA_DIR` and managed server storage before starting 1.3.0. Include `serversentinel.sqlite`, adjacent SQLite `-wal` and `-shm` files, `servers/`, and any export artifacts you rely on.
- Version 1.3.0 accepts a fresh database or a database fully migrated through schema 16. It compacts schema 16 transactionally into the schema-17 baseline.
- If the database is below schema 16, run serverSENTINEL 1.2.1 against that data root first. Let 1.2.1 finish startup, stop it cleanly, take another full backup, and then start 1.3.0.
- Do not run 1.3.0 directly against a pre-16 database. Do not run 1.2.1 against a database already compacted to schema 17.
- Rollback after compaction requires restoring the complete backup made immediately before the 1.3.0 startup.

## Import And Export Compatibility

Version 1.3.0 writes and accepts export schema 3 only. Schema-1 and schema-2 artifacts are rejected. To carry an older artifact forward, import it into 1.2.1 and create a new export before upgrading the data root.

## Panel And Node Upgrade Order

1. Upgrade and verify the panel first.
2. Leave 1.2.1 nodes running while the panel starts and reconnects them.
3. Upgrade every node agent to `nl2109/serversentinel:1.3.0`.
4. Confirm all nodes report the current agent version, build ID, protocol, Docker readiness, and required capabilities.

The panel tolerates extra fields sent by a 1.2.1 node during this short panel-first window. Protocol 2.0 validation and per-command capability enforcement remain strict.

## Removed Compatibility State

- Schedule commands and delay arrays were replaced by canonical schedule steps.
- `desiredRuntimeState` was replaced by `runtimeIntent`.
- Persisted node compatibility labels, badges, warnings, filters, and diagnostics counts were removed.
- Node hello/welcome payloads no longer carry redundant runtime, Docker, data-root, operation, protocol, or compatibility fields.

## Deployment Reminder

The published Docker workflow tags stable builds as `latest`, `1.3.0`, and the commit SHA. Keep the panel behind a LAN, VPN, tunnel, or TLS reverse proxy with strong authentication, and treat Docker socket access as administrative access to the host.
