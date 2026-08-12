# Server routing

The root `AGENTS.md` still applies. Use this table to enter the backend through the narrowest relevant area.

| Area | Start here |
| --- | --- |
| Process startup and composition | `src/index.ts`, `src/app.ts`, `src/appServices.ts`, `src/config.ts` |
| HTTP endpoints | `src/routes/`; shared request errors, validation, limits, and origin handling live in `src/http/` |
| Authentication and authorization | `src/auth/`, `src/permissions.ts`, `src/routes/authRoutes.ts` |
| Persistent data and migrations | `src/storage/database.ts` and the repository for the affected entity under `src/storage/` |
| Server lifecycle and observations | `src/servers/`, `src/runtimeStateCoordinator.ts`, `src/playerSnapshots.ts`, `src/serverTimeline.ts` |
| Runtime selection and artifacts | `src/runtime/`; Docker transport and logs live in `src/docker/` |
| Remote nodes and protocol | `src/nodes/protocol.ts`, `src/nodes/remoteNodeRuntime.ts`, `src/nodes/nodeAgent.ts` |
| Files and archives | `src/files/fileService.ts`, `src/core.ts`, `src/zipArchive.ts`, `src/downloadArchive.ts` |
| Mods and Modrinth | `src/mods/modService.ts`, `src/mods/managedContent.ts`, `src/modrinth/` |
| Schedules | `src/schedules/` and `src/routes/scheduleRoutes.ts` |
| Imports, exports, and operations | `src/operations/`, `src/importExport.ts`, `src/routes/importExportRoutes.ts` |
| Logging and shutdown | `src/logging.ts`, `src/shutdown.ts` |

- Keep colocated `*.test.ts` coverage with the module being changed. Run focused server tests with the root command documented in `AGENTS.md`.
- For runtime or node-protocol changes, also read `docs/runtime-architecture.md` or `docs/panel-node-protocol.md`, respectively.
