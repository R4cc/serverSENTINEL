# Changelog

## Unreleased

- Fixed mobile Node Details opening below its header, standardized compact tap targets, reduced Mods toolbar height, and expanded the mobile smoke coverage for those interactions.
- Fixed the Mods action toolbar compressing its bottom spacing against the installed-mods panel at desktop heights.
- Fixed a small ZIP file with deeply nested entry names exhausting panel or node memory when it was inspected for extraction or import.
- Fixed cancelling an operation that cannot actually be stopped reporting it as cancelled while the work continued, which also released the guard that kept a second extraction from starting into the same folder.
- Fixed requesting a server that does not exist, and downloading an export that is not finished, answering with a generic internal error instead of saying what was wrong.
- Fixed deleting a server while one of its own operations was still writing files, which could leave the container removed, the files half deleted, and the server still listed.
- Fixed an archive being swapped between the point its contents were approved and the point they were written, so files could be extracted into folders the request was never allowed to touch.
- Fixed an import that failed while restoring mod content deleting the imported server folders while leaving the servers listed in the panel.
- Imports now refuse up front when there is not enough free disk space, as exports already did.
- A server file whose name contains a backslash is now skipped from an export with a warning, instead of producing an archive that could not be imported at all.
- Fixed changing a server's Minecraft version leaving it on the old Java runtime image, so an upgrade across the 1.20.5 boundary downloaded a jar the container could not load and reported it only as a runtime exit. An image chosen by hand is still left alone.
- Fixed a stray promise rejection anywhere in the panel or a node agent terminating the process, which for the panel took down the control plane for every managed server.
- Fixed `server.properties` being renameable, and therefore replaceable, with only file-edit permission on servers hosted by a remote node.
- Fixed a console viewer that disconnected while its stream was still attaching leaking its subscription and holding the container log follow open for the life of the process. Deleting a server now also releases its console buffer.
- Fixed a schedule running twice for one cron occurrence when the panel restarted inside the matched minute, or when recording the previous run failed.
- Fixed a node agent flapping between its outgoing and replacement container during a self-update, and fixed an update started with a custom image being closed out by any reconnect at all.
- Fixed a failed Docker image pull being reported as success and resurfacing later as "No such image", and gave a first pull room to finish instead of timing out after 15 seconds.
- Fixed a node agent buffering console output without limit when a server outran the panel connection, which could exhaust the node's memory.
- Fixed updating a mod deleting the running copy when a disabled copy of the target version was also present, and reporting it as a successful update.
- Fixed the login rate limit being bypassable, and the demo-mode gate not covering the console stream.
- Reduced repeated Modrinth lookups and full jar re-reads when listing manually uploaded mods, and cleaned up install temporary files abandoned by an interrupted download.

## 26.8.22 - 2026-08-15

- The overview now remembers the last World Size and Free Space it measured, so a reload shows those figures straight away and replaces them once the new measurement arrives instead of holding both tiles on a placeholder.

## 26.8.21 - 2026-08-15

- Fixed the user and reset-password dialogs drawing a grey browser border around their contents and leaving empty strips above and below it.

## 26.8.20 - 2026-08-15

- A module that fails to start is now handled cleanly: enabling one reports the failure and leaves it switched off rather than recording a module that does not work, and one that fails while the panel starts is hidden from the interface and refuses its API instead of half-answering, while Settings keeps showing the setting you chose.
- Switching a module on or off can no longer interleave with another administrator doing the same, and a module setting written by a newer release is preserved instead of being dropped when an older one saves.

## 26.8.19 - 2026-08-15

- Managed content — mods, plugins, Modrinth browsing, and the hourly update check — is now an optional module alongside Schedules. Switching it off closes its API, stops the update checker being built at all, and takes the workspace, the overview content card, and the Modrinth API key setting with it. Installed jars are left untouched and are managed again as soon as it is switched back on.
- Accounts without `mods.view` no longer download the managed-content interface, which also makes the panel's initial download smaller for everyone.

## 26.8.18 - 2026-08-15

- Optional features can now be switched off for an installation. Settings gains a Modules category; Schedules is the first module, and turning it off stops scheduled runs, closes the schedule API, and hides the workspace while keeping every existing schedule and its history intact.
- A module is only visible to accounts that hold its permission — `schedules.view` for Schedules — so it can be enabled for the installation and still limited to the operators who should use it. The browser no longer downloads a module's code for anyone who cannot reach it.

## 26.8.17 - 2026-08-14

- Fixed servers on a pre-release Minecraft version, such as `1.21-pre1`, defaulting to the Java 17 container image instead of the Java 21 one the version needs. The panel, the node agent, and the create-server preview now all read the same rule.

## 26.8.16 - 2026-08-14

- Fixed renaming a server that runs on a node, or changing any of its settings, failing with "server.createdAt must be a non-empty string". The panel now keeps its own record of the server when a node answers an update, instead of expecting the node to return bookkeeping it was never sent.

## 26.8.15 - 2026-08-14

- The panel now explains that a node too old to update itself needs its container recreated, instead of offering a `docker pull` command that reads like the whole fix while leaving the old agent running.

## 26.8.14 - 2026-08-14

- Minecraft containers now get 60 seconds to save and shut down when something outside serverSENTINEL stops them, such as a Docker daemon restart during a package upgrade, instead of being killed after Docker's 10 second default. The window is configurable with `SERVERSENTINEL_MINECRAFT_STOP_TIMEOUT_SECONDS`.
- Stopping or restarting a server from the panel now waits out that full window rather than reporting a timeout while the world is still saving.
- The panel and node agents now warn at startup when Docker's `live-restore` is disabled, which is the host setting that keeps Minecraft containers running through a Docker daemon restart or upgrade.

## 26.8.13 - 2026-08-14

- Fixed node self-updates failing to start after the switch to the Distroless image, by letting the replacement container take its entrypoint, command, and other defaults from the new image instead of the outgoing one.
- A node update that cannot finish now restores the previous node container under its own name instead of leaving it renamed, and the node reports the reason back to the panel.
- The Nodes page now shows why the last update failed, with the stage it stopped at, whether the node recovered, and actions to retry, dismiss, or open the install instructions.
- Nodes running an agent from before the Distroless image change are now told to recreate their container once on the node host, instead of starting a panel update that cannot succeed.
- A finished server export can now be deleted from the server properties page, which removes its archive from panel storage.
- The export and danger zone cards on the server properties page now share a row instead of stacking.

## 26.8.12 - 2026-08-13

- Reduced container storage by retaining maximum-quality Brotli assets while compressing the uncommon gzip fallback on demand.
- Shortened container builds and reduced intermediate cache size by using the packaged SQLite binary without a compiler toolchain and caching npm downloads across dependency installs.

## 26.8.11 - 2026-08-13

- Reduced the container image and runtime attack surface with a shell-free Distroless Node image, guarded by final-image SQLite, timezone, fetch, and CA certificate checks.

## 26.8.10 - 2026-08-13

- Reduced the container image by retaining only the production Linux x64 SQLite binary and removing native build sources and unused platform binaries.

## 26.8.9 - 2026-08-13

- Kept the file editor's CodeMirror runtime out of the initial page download and added a build-time guard against loading it before the editor opens.
- Reduced production and development dependencies by using Node's built-in fetch, completing the TypeScript 7 migration, and removing redundant build overrides.

## 26.8.8 - 2026-08-13

- Loaded player counts on every server workspace page, so the status bar no longer waits for a visit to Overview before showing online players.

## 26.8.7 - 2026-08-13

- Kept the network in and network out timeline series continuous on remote nodes, where sharing one cached stats reading across several collections previously drew the rate as alternating zeroes and spikes.
- Aged remote node observations against the panel's own clock and kept the newest reading when responses arrive out of order, so a node whose clock differs from the panel's no longer forces a fresh round trip on every read.
- Removed the timeline's planned-schedule layer, from the "Planned schedules" toggle down to the per-request cron projection behind it, now that the viewport stops at the present and no window can contain a future run; upcoming runs remain on the Schedules panel.

## 26.8.6 - 2026-08-13

- Kept console logs at a stable size by settling the accelerated renderer before revealing output.
- Spread cached player-head refreshes across a rolling daily schedule while keeping visible-player requests responsive.
- Removed the obsolete export-retention setting now that successful export archives remain until replaced.
- Reduced repeat downloads and panel CPU use with stable vendor chunks, font preloads, and precompressed web assets.

## 26.8.5 - 2026-08-13

- Reduced player-head checks to once every 24 hours and shortened the integration explanation.

## 26.8.4 - 2026-08-13

- Removed the redundant Chromium liquid-glass outline while preserving the refractive glass effect, and kept the file-editor scrollbar visibly styled instead of allowing Windows to collapse it into an auto-hidden overlay.

## 26.8.3 - 2026-08-13

- Kept Chromium liquid-glass rims aligned with their surfaces and restored a visible file-editor scrollbar.

## 26.8.2 - 2026-08-13

- Removed the stray horizontal bands between the schedule editor's header, content, and footer.

## 26.8.1 - 2026-08-13

- Adopted calendar versions in the `YY.M.N` format, starting at `26.8.1`, with the release number incrementing within each month and resetting when the year or month changes.

## 1.15.0 - 2026-08-13

- Added live duration bars for active schedule runs to the Overview event timeline, including runs that began before the visible window, with direct navigation to the running execution.
- Added active schedule runs and their current status to the Overview Schedules card while preserving its four-row preview layout.
- Tightened the schedule create and edit workflow by removing redundant subtitles and compacting run-condition choices without hiding the wait-until-empty rules.

## 1.14.0 - 2026-08-13

- Added a preview of the next three runs to the schedule editor, so an expression can be checked against real dates before it is saved.
- Added the reader's own clock to that preview whenever the display time zone differs from the one schedules run in, which resolves a schedule written as 04:00 being listed as 06:00.
- Added a repeat builder to the schedule editor covering every few minutes or hours, every day, and chosen weekdays, so a schedule no longer has to be written as a cron expression. Advanced keeps the expression field, and an expression the builder cannot express opens there untouched.
- Added the offset from the scheduled start to each step, and a line stating when the last one runs, so a restart with warning commands can be read without adding the delays up.
- Added three schedule templates covering a nightly restart with warnings, an hourly save, and a weekly restart that waits for an empty server, as starting points a new schedule can be built from.
- Added Move up and Move down controls to each schedule step, so steps can be reordered on a touch screen and without a pointer.
- Showed the Restart rules while a schedule is built: Restart is offered only on the final step, and a reorder that would move it away from the end is refused instead of failing when saved.
- Added a View runs action to each schedule, showing every run the panel has kept for it rather than the eight most recent across all schedules.
- Replaced the repeated field captions on narrow screens with a schedule card, which returns roughly 40% of the row width to the values.
- Added Stop and Start schedule steps alongside Restart, so a server can be stopped overnight and started again in the morning. A schedule whose only action is Start now runs against a stopped server instead of being skipped, and existing Restart schedules are unaffected.
- Added a warning to schedules that have failed or skipped their last three runs, on the schedule itself and on the Overview, because a schedule quietly doing nothing otherwise reads exactly like one that is working.
- Added a Duplicate action to each schedule, which opens a pre-filled editor rather than saving a copy outright.
- Added a new schedule step above the closing Restart instead of after it, where it could not have run.
- Reworked the schedule create, edit, and duplicate modal into a wider, clearly grouped workflow that keeps timing, steps, and run conditions easy to scan across desktop and mobile layouts without repetitive helper copy.

## 1.13.0 - 2026-08-13

- Replaced the Server Properties saving banner and always-visible header actions with a compact bottom action dock that appears only for unsaved changes and animates progress inside the Save button.
- Added a compact New output action when console lines arrive while the reader is scrolled up, preserving their position until they choose to jump back to the live edge.
- Kept the console connected while a newly imported local server is waiting for its first Docker container, retained its startup log history, and stopped repeated reattach notices while the server is stopped.
- Kept the Server Properties Advanced hover surface aligned with its rounded card border in both collapsed and expanded states.

## 1.12.2 - 2026-08-13

- Fixed schedules silently losing an occurrence when a server export was running at their scheduled minute. The run is now recorded as skipped with the reason, and a schedule set to wait for players to leave queues behind the export instead.
- Fixed deleting a schedule while one of its runs was in progress, which left the run sending commands with no way to cancel it. Deleting now cancels the run first, and is refused while a Restart step is still finishing.

## 1.12.1 - 2026-08-13

- Fixed skipped and cancelled schedule runs being marked as failures in the Last run column, so a run that correctly skipped no longer looks like one that broke.
- Fixed the Schedules table describing cron expressions differently from the schedule editor, which printed raw cron fields such as "Weekly on 1-5" back at you.
- Fixed the Scheduled Runs feed scrolling itself back to the top every time the page refreshed its data.
- Renamed the schedule "Test now" action to "Run now" and added a confirmation for schedules that restart the server, because running one on demand performs every step for real.

## 1.12.0 - 2026-08-13

- Added page-visit notifications for available node updates, with one combined fleet alert, a three-day browser mute, and persistent per-node notification controls.

## 1.11.1 - 2026-08-13

- Fixed large server export imports being rejected with HTTP 413 by uploading archives in resumable, proxy-safe chunks.

## 1.11.0 - 2026-08-12

- Added a schedule start policy that can wait without timeout for all players to leave, keeps one cancellable run active, and ignores later matches instead of stacking them.

## 1.10.2 - 2026-08-12

- Kept the first-run setup guide on the step you selected instead of snapping back to the recommended step whenever panel data refreshed.
- Removed duplicated stylesheet rules left by the responsive-style colocation so node modals, the file manager, and summary tiles are described in one place each.

## 1.10.1 - 2026-08-12

- Made dark mode the default for new browser sessions while keeping light and system themes available.
- Updated the automated README screenshots to showcase dark mode by default and include a light-mode example.

## 1.10.0 - 2026-08-12

- Added a resumable first-run experience that guides administrators through host selection, server creation or import, the first successful start, and optional integrations.
- Refreshed administrator setup guidance and deferred optional player-head configuration until the essential server setup is complete.
- Added a guarded Clear UI cache action under System settings that clears browser-held panel files and data, signs the current browser out, and reloads only after active work has settled.

## 1.9.6 - 2026-08-12

- Corrected managed-server creation defaults, Docker readiness and failure guidance, review accessibility, and node memory labeling.

## 1.9.5 - 2026-08-11

- Kept mobile Mods rows aligned when names, statuses, and installed versions have different lengths.
- Replaced the oversized mobile Overview loading block with card-shaped summary and panel skeletons that match the loaded page.

## 1.9.4 - 2026-08-11

- Kept the Overview mod-update card at a stable height while checking for updates and animated the refresh icon for the duration of the check.

## 1.9.3 - 2026-08-11

- Kept the server status controls beside the server details whenever the bar has room, instead of wrapping them at fixed desktop viewport widths.
- Fell back to building an export archive on the panel when the node that owns the server refuses to stream one, instead of failing the whole export.
- Stopped reusing a size estimate measured while a server was still running, which could fail the export it was meant to speed up once the server was stopped.

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
