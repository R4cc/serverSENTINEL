# Optional feature modules

## Overview

serverSENTINEL's core is the part no installation can do without: nodes, servers, runtime control, console, files, properties, users, and settings. Everything else is a candidate for a **module** — a first-party feature an installation can switch off without losing anything else.

A module is not a plugin. There is no package format, no download, no independent version: module code ships inside serverSENTINEL and is written like the rest of it. What a module adds is a boundary — one place that decides whether the feature exists for an installation, and enough structure that switching it off actually stops the work rather than only hiding a button.

Three modules ship today:

| Module | Owns | Governed by |
| --- | --- | --- |
| `schedules` | The Schedules workspace, the schedule API, and the poll that decides what is due | `schedules.view` |
| `managedContent` | The Mods/Plugins workspace, the mod and Modrinth API, and the hourly update check | `mods.view` |
| `playerInsights` | The Players workspace, insights API, GeoLite2 lookup, and live TCP ping measurement | `players.view` |

## The two gates

Whether a module reaches a person is decided twice, and both answers must be yes.

| Gate | Scope | Where it lives |
| --- | --- | --- |
| Installation | Everyone | `modules.disabled` in `storage_metadata`, held by `ModuleRegistry` |
| User | One account | The module's `accessPermission`, an ordinary permission |

Nothing new has to be administered for the second gate. A module declares which existing permission governs it — `schedules` uses `schedules.view` — so role presets and per-user grants already scope it, and an installation that wants schedules for two of its five operators does what it always did.

The panel enforces both gates on every request. The browser applies the same two gates to decide what to *load*, which is a saving, not the security boundary.

## What being switched off means

- **Endpoints are refused.** Every route a module registers sits in its own Fastify scope behind an `onRequest` guard, so a disabled module answers `403 MODULE_DISABLED`. A route added to the module later inherits the guard rather than having to remember it. The same guard answers `503 MODULE_UNAVAILABLE` for a module that is switched on but whose runtime is not running, so a failed module refuses cleanly instead of half-answering.
- **Background work stops, and never starts.** A module's pollers and timers are a `ModuleRuntime` that the registry starts and stops as the switch moves. A runtime may also build the services its own routes use — managed content builds its update-plan coordinator, and the plan cache behind it, in `start` — so a switched-off module is not merely idle: it was never constructed. `setEnabled` is deliberately asymmetric about this: the runtime starts *before* the endpoints open and stops *after* they have closed, so a request can never reach a half-built module.
- **Frontend code is not downloaded.** Each module owns a dynamic import. Navigation, hover prefetch, idle prefetch, and restored navigation all ask `isPageAvailable` first, so an unreachable module's chunk is never requested.
- **Data is kept.** Disabling is not deleting. Existing schedules, their history, and their next run times survive; the feature resumes where it left off when it is switched back on.

Runs already in flight are left to finish. Interrupting a schedule midway through a restart would leave a server in the state its operator least expects.

Disabling is never destructive to what a server holds. Switching managed content off leaves every installed jar where it is — the server keeps loading them, and they are managed again the moment the module returns. The panel simply stops offering to change them.

## When something goes wrong

`enabled` is the administrator's setting; `accessible` is whether the module can actually be used. They come apart when a runtime fails:

- **Enabling fails.** The runtime starts before anything is written, so a module that cannot start stays off and the caller gets `503 MODULE_CHANGE_FAILED` with the reason in the log. Nothing is left half-changed.
- **A runtime fails at boot.** The panel still starts — one module is not the rest of the panel's hostage — but that module reports `accessible: false`, so no browser offers it, and its endpoints answer `503`. Settings still shows the operator's setting, and switching it off and on retries.
- **A start throws partway through.** The registry calls the runtime's `stop` immediately, so a half-built runtime does not linger until shutdown.
- **Two administrators toggle at once.** Every change is serialized, so starts and stops cannot interleave.
- **A module id this build does not know.** Its setting is written back untouched, so rolling a panel back and forward again does not silently switch a feature on.

## Adding a module

1. **Describe it** in `shared/src/modules.ts`: id, label, summary, what stops happening while it is off, the permission that scopes it, and the permissions it owns. Every consumer reads this one catalog.
2. **Register its routes** in `app.ts` through `services.moduleRegistry.registerRoutes(app, id, register)` instead of calling the route registrar directly.
3. **Register its background work**, if it has any, with `services.moduleRegistry.registerRuntime(id, runtime)`.
4. **Add its browser entry** to `web/src/app/moduleRegistry.ts`: a `lazyPage` import for the module's component and one row mapping the module to the workspace page it owns.
5. **Render it** in `App.tsx` behind that page's availability check, and give its navigation entry in `AppSidebar.tsx` the same check.
6. **Add its page** to the `ActivePage` union, the stored-navigation allowlist, the prefetch queue, and the workspace titles.

Step 6 is the one that is easy to half-finish, so it is not left to memory: `web/src/app/moduleRegistry.test.ts` walks the registry and fails if any module page is missing from one of those lists, and `AppSidebar.test.tsx` fails if a module's navigation entry is offered when the module is not reachable. Settings needs no change at all — the Modules category is generated from the shared catalog.

## Where the boundary is

A module's browser code should live behind its dynamic import, state included. Both modules keep their workspace hook inside the module component rather than in the shell, which is what makes "not loaded" true rather than approximately true. Where the shell genuinely needs something from a module it travels outward as a value, not by hoisting the module's state back up: `schedules` reports whether a mutation is in flight, and `managedContent` publishes a small bridge — the update plan, a busy flag, and two actions — that the overview card and the file manager read.

Decisions written in a module's vocabulary belong to the module. The shell passes conditions it already owns for its own sake — provisioning, runtime reachability, an export holding the server, the panel's job list — and the module turns them into its own answers: `features/mods/modAccess.ts` decides what "locked" means for mods and phrases every reason in mods-or-plugins wording, including which job types count as its own. The shell should not be able to describe a module's rules.

**A module that feeds a core page has to outlive its own page.** Managed content backs the overview's content-health card, so it is mounted for as long as a server is selected rather than only while the Mods page is open, and outside the per-server key. Mounting it with its page instead threw its loaded list away on every visit to Settings and re-fetched it on the way back. Its component renders `null` until its page is open, so the longer life costs nothing visually. A module that feeds nothing outside itself — `schedules` — should stay mounted with its page.

Core features stay core, even where a module is their main consumer. The node-runtime mod adapters, `supportsManagedMods`, restart-required tracking, the `/mods` file-manager permission mapping, and the export/import content category all remain core: import/export and the node protocol need them whether or not managed content is switched on.

A feature is a good module candidate when it owns a distinct workspace page, has its own permissions, and its background work is separable from the server lifecycle. A feature the rest of the panel calls into during ordinary operation is not: the coupling would have to be paid for at every call site, in exchange for a switch few operators would use.

## When switching off is a promise, not a preference

`playerInsights` is the first module whose switch means something stronger than "hide this feature". It is the only part of serverSENTINEL that ever *reads* a player's IP address: the Minecraft server logs one at login, the module resolves it against a GeoLite2 database and keeps the normalized endpoint only while matching the connected player to a live TCP socket. Nothing writes or hashes the endpoint, sends it to a geolocation service, includes it in the player API, or puts it in retained statistics. The stored geography table holds only a city, country, continent, approximate coordinates, and accuracy radius; resource history holds anonymous RTT arrays.

Be precise about the scope of that promise. Player Insights does not store an address, and no address is sent to MaxMind or any other third party — MaxMind is asked for a database file, never about a player. It is *not* a claim that the address never leaves the machine the Minecraft server runs on: a server on a remote node streams its console output to the panel over the node protocol, addresses and all, and did so before this module existed. Copy that says otherwise is wrong, so the wording in the UI, the changelog, and the contract all state the guarantee the code actually makes.

So the module's `stop` has to be believable. It drops the collector *and* the database reader, and it bumps a generation counter that orphans any download already in flight: a refresh that outlives the switch cannot install a database, adopt a reader, or write state, and its fetch is aborted rather than left running. With the module off, no MMDB is held in memory, no login line is parsed, and no request reaches MaxMind. `server/src/appServices.ts` types both as optional and the routes reach them through the registry, so there is no way to read a player address from a switched-off module.

Two further properties are worth knowing before changing this code:

- **A working database keeps working.** A download is opened and checked to be a City database *before* it replaces the file in use. A truncated or corrupt refresh costs an installation an error message, never the geography it already had, and the temporary file is cleaned up on every path out.
- **The collector fetches nothing.** It subscribes to the console output `TimelineEventCollector` already reads for the timeline, so the module adds no node request of its own. Unsubscribing is the whole of the gate: with the module off the panel still reads those logs, for the timeline, and nothing looks at a login line.

Two things follow from that:

- **The credential is core, the use is not.** MaxMind's account ID and license key live in `app_settings` beside the Modrinth key, and the Modules settings hides the row when the module is off — exactly as it does for Modrinth. The credential authorizes a *download*; it is never used for a lookup.
- **Nothing is bundled.** The image ships no GeoLite2 copy. A database baked into a container image is stale the week after it is built, and GeoLite2's licence expects installations to keep theirs current. An installation with no credentials has no geography, and the workspace says so instead of guessing.

Player ping is the Linux host's TCP round-trip time, read from `tcp_info` inside the Minecraft container's network namespace. Matching requires the exact normalized remote address and source port from the player's login line; there is deliberately no address-only fallback for players behind NAT or proxies. Non-Linux hosts, older nodes without the optional capability, inaccessible sockets, proxies without usable source ports, and failed matches report ping as unavailable rather than substituting a geographic estimate.

Because that estimate is also drawn for the past, geography is stored as a short history rather than a latest place: one row per run of joins from the same location, added only when the derived place changes. A session that happened last Tuesday is estimated from where the player was last Tuesday. With a single row per player, one person moving between continents silently rewrote every hour of the connection-quality chart. Sessions older than the first location the panel recorded contribute to the player count and to nothing else, because nobody recorded where that player was then.
