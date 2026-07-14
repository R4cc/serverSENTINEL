# Changelog

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
