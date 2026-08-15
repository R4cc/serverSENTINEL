# Optional feature modules

## Overview

serverSENTINEL's core is the part no installation can do without: nodes, servers, runtime control, console, files, properties, users, and settings. Everything else is a candidate for a **module** — a first-party feature an installation can switch off without losing anything else.

A module is not a plugin. There is no package format, no download, no independent version: module code ships inside serverSENTINEL and is written like the rest of it. What a module adds is a boundary — one place that decides whether the feature exists for an installation, and enough structure that switching it off actually stops the work rather than only hiding a button.

Two modules ship today:

| Module | Owns | Governed by |
| --- | --- | --- |
| `schedules` | The Schedules workspace, the schedule API, and the poll that decides what is due | `schedules.view` |
| `managedContent` | The Mods/Plugins workspace, the mod and Modrinth API, and the hourly update check | `mods.view` |

## The two gates

Whether a module reaches a person is decided twice, and both answers must be yes.

| Gate | Scope | Where it lives |
| --- | --- | --- |
| Installation | Everyone | `modules.disabled` in `storage_metadata`, held by `ModuleRegistry` |
| User | One account | The module's `accessPermission`, an ordinary permission |

Nothing new has to be administered for the second gate. A module declares which existing permission governs it — `schedules` uses `schedules.view` — so role presets and per-user grants already scope it, and an installation that wants schedules for two of its five operators does what it always did.

The panel enforces both gates on every request. The browser applies the same two gates to decide what to *load*, which is a saving, not the security boundary.

## What being switched off means

- **Endpoints are refused.** Every route a module registers sits in its own Fastify scope behind an `onRequest` guard, so a disabled module answers `403 MODULE_DISABLED`. A route added to the module later inherits the guard rather than having to remember it.
- **Background work stops, and never starts.** A module's pollers and timers are a `ModuleRuntime` that the registry starts and stops as the switch moves. A runtime may also build the services its own routes use — managed content builds its update-plan coordinator, and the plan cache behind it, in `start` — so a switched-off module is not merely idle: it was never constructed. `setEnabled` is deliberately asymmetric about this: the runtime starts *before* the endpoints open and stops *after* they have closed, so a request can never reach a half-built module.
- **Frontend code is not downloaded.** Each module owns a dynamic import. Navigation, hover prefetch, idle prefetch, and restored navigation all ask `isPageAvailable` first, so an unreachable module's chunk is never requested.
- **Data is kept.** Disabling is not deleting. Existing schedules, their history, and their next run times survive; the feature resumes where it left off when it is switched back on.

Runs already in flight are left to finish. Interrupting a schedule midway through a restart would leave a server in the state its operator least expects.

Disabling is never destructive to what a server holds. Switching managed content off leaves every installed jar where it is — the server keeps loading them, and they are managed again the moment the module returns. The panel simply stops offering to change them.

## Adding a module

1. **Describe it** in `shared/src/modules.ts`: id, label, summary, what stops happening while it is off, the permission that scopes it, and the permissions it owns. Every consumer reads this one catalog.
2. **Register its routes** in `app.ts` through `services.moduleRegistry.registerRoutes(app, id, register)` instead of calling the route registrar directly.
3. **Register its background work**, if it has any, with `services.moduleRegistry.registerRuntime(id, runtime)`.
4. **Add its browser entry** to `web/src/app/moduleRegistry.ts`: a `lazyPage` import for the module's component and one row mapping the module to the workspace page it owns.
5. **Render it** in `App.tsx` behind that page's availability check.

Settings needs no change: the Modules category is generated from the shared catalog. Neither does the sidebar beyond wrapping the module's own nav entry in `isPageAvailable`.

## Where the boundary is

A module's browser code should live behind its dynamic import, state included. Both modules keep their workspace hook inside the module component rather than in the shell, which is what makes "not loaded" true rather than approximately true. Where the shell genuinely needs something from a module it travels outward as a value, not by hoisting the module's state back up: `schedules` reports whether a mutation is in flight, and `managedContent` publishes a small bridge — the update plan, a busy flag, and two actions — that the overview card and the file manager read.

**A module that feeds a core page has to outlive its own page.** Managed content backs the overview's content-health card, so it is mounted for as long as a server is selected rather than only while the Mods page is open, and outside the per-server key. Mounting it with its page instead threw its loaded list away on every visit to Settings and re-fetched it on the way back. Its component renders `null` until its page is open, so the longer life costs nothing visually. A module that feeds nothing outside itself — `schedules` — should stay mounted with its page.

Core features stay core, even where a module is their main consumer. The node-runtime mod adapters, `supportsManagedMods`, restart-required tracking, the `/mods` file-manager permission mapping, and the export/import content category all remain core: import/export and the node protocol need them whether or not managed content is switched on.

A feature is a good module candidate when it owns a distinct workspace page, has its own permissions, and its background work is separable from the server lifecycle. A feature the rest of the panel calls into during ordinary operation is not: the coupling would have to be paid for at every call site, in exchange for a switch few operators would use.
