# serverSENTINEL 1.3.0 Release Notes

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
