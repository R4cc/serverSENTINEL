# Optional feature modules

## Overview

serverSENTINEL's core is the part no installation can do without: nodes, servers, runtime control, console, files, properties, users, and settings. Everything else is a candidate for a **module** — a first-party feature an installation can switch off without losing anything else.

A module is not a plugin. There is no package format, no download, no independent version: module code ships inside serverSENTINEL and is written like the rest of it. What a module adds is a boundary — one place that decides whether the feature exists for an installation, and enough structure that switching it off actually stops the work rather than only hiding a button.

`schedules` is the first module and is the reference implementation.

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
- **Background work stops.** A module's pollers and timers are a `ModuleRuntime` that the registry starts and stops as the switch moves. The schedules poll is not running while schedules are off.
- **Frontend code is not downloaded.** Each module owns a dynamic import. Navigation, hover prefetch, idle prefetch, and restored navigation all ask `isPageAvailable` first, so an unreachable module's chunk is never requested.
- **Data is kept.** Disabling is not deleting. Existing schedules, their history, and their next run times survive; the feature resumes where it left off when it is switched back on.

Runs already in flight are left to finish. Interrupting a schedule midway through a restart would leave a server in the state its operator least expects.

## Adding a module

1. **Describe it** in `shared/src/modules.ts`: id, label, summary, what stops happening while it is off, the permission that scopes it, and the permissions it owns. Every consumer reads this one catalog.
2. **Register its routes** in `app.ts` through `services.moduleRegistry.registerRoutes(app, id, register)` instead of calling the route registrar directly.
3. **Register its background work**, if it has any, with `services.moduleRegistry.registerRuntime(id, runtime)`.
4. **Add its browser entry** to `web/src/app/moduleRegistry.ts`: a `lazyPage` import for the module's component and one row mapping the module to the workspace page it owns.
5. **Render it** in `App.tsx` behind that page's availability check.

Settings needs no change: the Modules category is generated from the shared catalog. Neither does the sidebar beyond wrapping the module's own nav entry in `isPageAvailable`.

## Where the boundary is

A module's browser code should live behind its dynamic import, state included. `schedules` keeps its workspace hook inside `SchedulesModule.tsx` rather than in the shell, which is what makes "not loaded" true rather than approximately true. Where the shell genuinely needs one fact from a module — the UI cache control has to know whether a schedule mutation is in flight — it travels as a callback, not by hoisting the module's state back up.

Core features stay core. A feature is a good module candidate when it owns a distinct workspace page, has its own permissions, and its background work is separable from the server lifecycle. A feature that the rest of the panel calls into during ordinary operation is not: the coupling would have to be paid for at every call site, in exchange for a switch few operators would use.
