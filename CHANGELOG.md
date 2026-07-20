# Changelog

## 1.5.2 - 2026-07-20

- Migrated the build and type-check pipeline to the TypeScript 7 native compiler while retaining the TypeScript 6 compatibility API used by the SQL safety test.

## 1.5.1 - 2026-07-19

- Added panel-first node protocol 3.1 with negotiated request cancellation and binary-transfer features, bounded control frames and concurrency, heartbeat liveness, duplicate-session replacement, and jittered reconnect backoff.
- Consolidated remote monitoring into batched `server.observe` requests with shared panel caching, one reused container inspection per server, partial section errors, and cursor-based log deltas. Protocol 3.0 nodes retain the existing individual commands.
- Added SHA-256-verified streamed file, archive-entry, mod, and plugin transfers plus multipart HTTP uploads. Legacy JSON uploads remain compatible, while protocol 3.0 transfers above 72 MiB return an update-required error.
- Classified nodes as current, fallback, update-only, or incompatible so protocol 3.0 remains usable with an update recommendation and protocol 2.0 remains available only as a self-update bridge.

## 1.4.0 - 2026-07-17

- Improved Server Timeline event annotations with stacked previews for up to four clustered events and a remaining-event indicator.
- Stabilized timeline resource-series rendering and drag-to-pan interaction.

## 1.3.0 - 2026-07-15

- Established SQLite schema 17 as a compact baseline for fresh databases and databases fully migrated through schema 16. Older databases must stage through 1.2.1 first.
- Removed legacy schedule columns, desired-runtime-state storage, node compatibility state, and historical migration rows while preserving canonical data.
- Made canonical schedule steps and runtime intent the only current API, persistence, and export representations.
- Bumped import/export artifacts to schema 3 and removed schema-1/2 import compatibility.
- Slimmed the node handshake while retaining protocol 2.0 validation, capability checks, and panel-first upgrade tolerance for extra 1.2.1 hello fields.
- Removed verified unused TypeScript declarations and retired pre-redesign CSS selectors.

## 1.2.1 - 2026-07-14

- Bumped package, panel, node image, Docker, and release-facing version metadata to 1.2.1.
- Added typed schedule steps with delayed commands and a first-class Restart procedure.
- Added persisted lifecycle intent, graceful Minecraft restarts, bounded crash recovery, and crash-loop status reporting.
- Fixed page-entry motion trapping the file editor and other fixed dialogs inside page content.

## 1.2.0 - 2026-07-13

- Bumped package, panel, node image, Docker, and release-facing version metadata to 1.2.0.

## 1.0.3 - 2026-07-09

- Bumped the panel, node image defaults, and release-facing UI metadata to 1.0.3.

## 1.0.2 - 2026-07-08

### Fixed

- Clean up previous node containers after successful node self-upgrades while retaining them when replacement startup or health verification fails.

## 1.0.0 - 2026-07-07

serverSENTINEL 1.0.0 is the first stable release line for the Docker-based Minecraft server panel.

### Added

- Stable 1.0 version metadata across package manifests, app display, Docker image tags, and node install instructions.
- SQLite-backed storage model with migrations, WAL-mode durability, backup guidance, and import/export artifacts.
- Release smoke-test runbook covering first-admin setup, managed Fabric provisioning, console, files, mods, schedules, import/export, and node-mode verification.
- CI release gate for `npm ci`, typecheck, tests, build, and Docker image build.

### Hardened

- Authentication/session cleanup, logout cookie behavior, same-origin checks, rate limits, and error redaction.
- Storage durability around SQLite migration ordering, WAL backups, operation retention, resource-stat pruning, stale file edit leases, import rollback, atomic file writes, mod downloads, and failed server provisioning cleanup.
- Modrinth and MCJars request behavior with product user agents, HTTPS-only mod downloads, size limits, hash verification, and safer API-key handling.

### Changed

- Docker examples now pin `nl2109/serversentinel:1.0.0` for repeatable releases and document `latest` as the moving stable tag.
- All-in-one Docker examples use separate persistent volumes for panel state and managed server directories.
- Demo mode is disabled unless both the frontend build and backend runtime explicitly opt in.

### Upgrade Notes

- 0.8.x data roots can be used directly by 1.0.0 when the same `SERVERSENTINEL_DATA_DIR` and server-file volume mapping are preserved.
- Pre-0.8 JSON state files are not imported by 1.0.0; move those installations through 0.8.x first or start with a fresh 1.0.0 data root.
- Upgrade panel and node agents to the same image tag. Mixed versions should only be used during a short rolling update window.
