# Changelog

## Unreleased

## 1.9.2 - 2026-08-11

- Stopped a node that dropped mid-export from crashing the panel, which failed large world exports with "Operation did not complete before serverSENTINEL restarted" instead of naming the node that disconnected.
- Kept a node connected while the panel pauses its socket for download backpressure, so a large export is no longer terminated by the heartbeat it cannot answer.
- Redesigned the Overview server summary cards around a rounded icon container, with clearer label and value hierarchy and a calmer status treatment.

## 1.9.1 - 2026-08-11

## 1.9.0 - 2026-08-10

## 1.8.2 - 2026-08-10

- Expanded the Overview workspace and refreshed the README screenshots.
- Sped up interface animations and polished UI states.
- Stabilized player timeline roster interactions.

## 1.8.1 - 2026-08-10

- Improved server management workflows and interface consistency across the application.
- Strengthened Overview support-card coverage for dense mod-update states.
- Stabilized console copy smoke setup and softened the main-page background gradients.

## 1.8.0 - 2026-08-04

- Introduced a responsive liquid-glass visual system with shared surfaces, refined motion, and calmer reduced-motion states across the application.
- Polished navigation, runtime controls, status summaries, Mods, Settings, user management, and Console presentation for clearer hierarchy and more consistent interaction feedback.
- Simplified application workflows, removed obsolete server-strip controls, and reduced redundant client and server work.

## 1.7.3 - 2026-08-04

- Stopped a console stream that ended from leaving an online node reported as offline until the browser was reloaded.
- Copied the console's selected output with Ctrl+C.
- Renamed the Nodes toolbar "Import" button to "Import server".
- Simplified the sign-in and first-run pages with consistent inline validation, alerts, and session-ended messaging.

## 1.7.2 - 2026-08-03

- Showed the console command caret.
- Refreshed server data when pages reactivate.
- Closed the timeline event popover on a click outside it.
- Updated dependencies to their most recent compatible versions.

## 1.7.1 - 2026-08-01

- Took the console prompt out of the terminal and made the command line a real input with its own type, so focus, hover, caret, and wrapped mobile input behave like a normal field.
- Drew the console only once it has a width to wrap against, and kept it on screen when the on-screen keyboard opens.
- Kept the console terminal and the overview timeline alive between page visits, and made the first visit to a page as fast as a repeat one.
- Preserved the workspace shell while the session resolves instead of flashing the sign-in surface.
- Persisted the active server selection and exposed runtime intent.
- Moved user management out of the authentication panel.
- Added a browser smoke covering the console's drawn behaviour.

## 1.7.0 - 2026-07-29

- Set the direct upgrade floor to panel/node 1.6.2, SQLite schema 20, export schema 3, and panel-node protocol 3.1.
- Removed protocol 2.0/3.0 handshake modes, JSON/base64 upload fallbacks, pre-schema-20 migrations, deprecated Fabric catalog routes, runtime-profile response aliases, and old flat API-error handling.
- Require binary transfer features for remote nodes and multipart form data for browser file and managed-content uploads.

## 1.6.3 - 2026-07-28

- Added structured API request and audit logging with authenticated actor context, normalized routes, durations, and redaction of sensitive request data.
- Improved Overview event grouping, scheduled-event presentation, and player-head rendering across monitoring surfaces.
- Refined timeline session state and event-rail behavior for clearer live and retained player activity.

## 1.6.2 - 2026-07-28

- Extended Server Timeline retention to seven days and stabilized player-session merging, hover state, and long-running session display.
- Improved Console rendering with ordered history replay, optional WebGL acceleration, and more readable shared monospace defaults.
- Refined Overview, Nodes, schedules, and responsive layouts while removing dead code and redundant styles.

## 1.6.1 - 2026-07-26

- Centralized permission definitions and shared server/node wire contracts, enforced version-catalog permissions, and drained active work during shutdown.
- Decomposed backend application setup into domain services and route modules, and shared browser-test and log-event helpers.
- Removed obsolete console chat, extra themes, in-browser ZIP navigation, and the stale pnpm lockfile.

## 1.6.0 - 2026-07-25

- Added horizontal Server Timeline navigation, player heads with privacy controls and caching, and player-aware stop and restart confirmations.
- Improved server-management workflows, Overview feedback, mobile Mods behavior, and console/player presentation.
- Self-hosted the Switzer interface font and streamlined frequently used server and web paths.

## 1.5.5 - 2026-07-24

- Added ECharts-backed player-session timelines, quick-reconnect collapsing, and improved marker navigation and hover behavior.
- Randomized complete demo sessions while keeping Overview, events, resources, console, and timeline fixtures internally consistent.
- Simplified application workflows and refreshed the release smoke and screenshot automation paths.

## 1.5.3 - 2026-07-22

- Secured import and export authorization, added automatic export-artifact expiry, and hardened generated-file handling.
- Stabilized API error responses, terminal initialization, snapshot loading, and runtime workflows.
- Improved Server Timeline guides, labels, lifecycle markers, and monitoring presentation.

## 1.5.2 - 2026-07-20

- Migrated the build and type-check pipeline to the TypeScript 7 native compiler while retaining the TypeScript 6 compatibility API used by the SQL safety test.

## 1.5.1 - 2026-07-19

- Added panel-first node protocol 3.1 with negotiated request cancellation and binary-transfer features, bounded control frames and concurrency, heartbeat liveness, duplicate-session replacement, and jittered reconnect backoff.
- Consolidated remote monitoring into batched `server.observe` requests with shared panel caching, one reused container inspection per server, partial section errors, and cursor-based log deltas. Protocol 3.0 nodes retain the existing individual commands.
- Added SHA-256-verified streamed file, archive-entry, mod, and plugin transfers plus multipart HTTP uploads. Legacy JSON uploads remain compatible, while protocol 3.0 transfers above 72 MiB return an update-required error.
- Classified nodes as current, fallback, update-only, or incompatible so protocol 3.0 remains usable with an update recommendation and protocol 2.0 remains available only as a self-update bridge.

### Upgrade Notes

- Upgrade the panel before its node agents. Protocol 3.0 nodes remain operational during the rolling upgrade, while protocol 2.0 nodes connect only long enough to self-update.
- See the [panel-node protocol](docs/panel-node-protocol.md) for negotiated features, transport limits, and compatibility behavior.

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

### Upgrade Notes

- Back up the complete `SERVERSENTINEL_DATA_DIR` and managed server storage before upgrading. Include `serversentinel.sqlite`, adjacent SQLite `-wal` and `-shm` files, `servers/`, and any export artifacts you rely on.
- Version 1.3.0 accepts a fresh database or one fully migrated through schema 16. For an older database, run 1.2.1 against the data root first, let its migrations finish, stop it cleanly, and take another complete backup before starting 1.3.0 or later.
- Rollback after schema compaction requires restoring the complete pre-upgrade backup.
- Current releases accept export schema 3. Convert a schema-1 or schema-2 artifact by importing it into 1.2.1 and creating a new export before upgrading.

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
