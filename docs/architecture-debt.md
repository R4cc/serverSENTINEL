# Architecture debt register

The larger architectural problems found by the architecture audit of November 2026. They are ranked
by their effect on reliability, maintainability and future development. Each one needs design
work or a staged migration, so none was rewritten during the audit. Every entry names the evidence,
explains why it matters, and gives a first step that is safe to take on its own.

Small, behavior-preserving fixes from the same audit were made directly. They are listed under
[Already addressed](#already-addressed) so they are not re-reported.

| # | Problem | Area | Reliability | Maintainability | Next step |
| --- | --- | --- | --- | --- | --- |
| 1 | Local and node runtimes reconcile containers with two drifting implementations | runtime | High | High | One pure `containerConfigSpec` |
| 2 | Local server updates have no recovery journal; the node path does | runtime | High | Medium | Share `NodeServerUpdateRecovery` |
| 3 | HTTP status and public message are inferred from error text | server HTTP | High | Medium | Typed errors at the throw sites |
| 4 | Global mutable `services` locator and a 745-line composition function | server | Medium | High | Pass a container to route factories |
| 5 | Two server-mutation gates, entered in different orders | server | Medium | Medium | One coordinator with two lease kinds |
| 6 | `NodeRuntime` seam is untyped and bypassed with `nodeId` and `instanceof` checks | runtime | Medium | High | Type `serverStatus` and `lifecycle` first |
| 7 | Wire response types are declared only in `web/src/types.ts` | contracts | Medium | Medium | Move them to `shared/`, annotate server builders |
| 8 | Console pipeline and other feature state still live in `App.tsx` | web | Medium | High | Extract `useConsoleWorkspace` |
| 9 | `mods/modService.ts` is a 1,700-line module with mixed concerns | server mods | Low | High | Split by use case |
| 10 | Demo simulation is interleaved with production workspace logic | web | Low | Medium | A demo adapter per workspace |
| 11 | Background loops and polling are hand-rolled with different semantics | both | Medium | Medium | One `IntervalWorker` / `usePollingEffect` |
| 12 | Caches and in-flight dedupe are hand-copied with differing eviction | server | Low | Medium | `boundedCache.ts` helpers |
| 13 | Oversized UI units: `ServerTimeline.tsx`, `SchedulesPage.tsx`, `ServerCreatePage.tsx` | web | Low | Medium | Extract the data hooks first |
| 14 | Inconsistent request cancellation across web workspaces | web | Medium | Medium | Standardize on `createRequestScope` |
| 15 | Remaining import cycles | both | Low | Low | Untangle `modService` ↔ `modHistory` |

## 1. Two container reconciliation implementations

The panel's local runtime (`server/src/runtime/local/dockerContainers.ts`, `dockerRuntimeConfigHashInput`
and `ensureDockerContainer`) and the node agent (`server/src/nodes/nodeAgent.ts`,
`runtimeConfigHashInput`, `createContainer` and `ensureContainer`) both decide when a Minecraft
container is out of date. Both write the same `containerConfigHash` label, but they hash different
inputs. The local side includes the working directory, bind target, volume subpath and restart
policy. The node side includes `timeZone` and leaves the mount fields out. The create bodies also
differ: the local side builds the command with `shellQuote`, while the node side uses its own
`minecraftContainerCommand` wrapper and a single `${root}:/data` bind.

**Why it matters.** Any change to "what counts as container configuration" has to be made twice.
The two sides already disagree, and nothing tests one against the other. The missing-network
recovery and the post-start "did it stay up" probe are also written twice: locally in
`dockerAction` (`dockerContainers.ts`), and for nodes in `nodeAgent.ts` plus the panel-side wrapper
in `remoteNodeRuntime.ts`.

**First step.** Extract a pure `containerConfigSpec(server, runtimeOptions)` that owns the hash
input and the create-body shape, with each side supplying only its mount. Start with the hash
input: it is pure and can be unit-tested against both callers. Keep the legacy-hash fallbacks so
existing containers are not recreated.

## 2. Local updates have no recovery journal

On a node, `updateServer` snapshots the affected files with `NodeServerUpdateRecovery.prepare`,
writes the version metadata and `server.properties`, and restores the snapshot on failure
(`nodes/serverUpdateRecovery.ts`). The local path (`servers/localRuntimeAdapter.ts`,
`localUpdateServer`) persists metadata with `serversRepository.replaceMetadata` before the
container work, then writes the version file and `server.properties` after the container is
replaced. A failure in between leaves the jar, the stored metadata and the properties in different
states. The two writers of `.serversentinel-version.json` also disagree on `createdAt`:
`servers/versions.ts` always sets it to now, while the node preserves the existing value.

**First step.** Move the journal's prepare and recover calls into a helper used by both
`updateServer` implementations, with the same file order on both sides. Decide the `createdAt`
semantics first, because unifying the two writers changes it on one side.

## 3. Error status inferred from message text

`isExpectedUserError` (`server/src/logging.ts`) matches words such as `required`, `invalid`,
`not found` and `cannot be` in `error.message`. `app.ts` uses it to choose 400 or 500 for any plain
`Error`, and `publicApiError` (`http/errors.ts`) returns the raw message for every status below
500. `stableErrorCode` derives the public error code from about 17 further message regexes. The
backend has about 580 plain `throw new Error(` sites.

**Why it matters.** Rewording a message can change the status code, the public error code and the
log level. An internal failure whose message happens to contain "invalid" becomes a 400 and its
internal text is sent to the client.

**Already done.** `logging.test.ts` now pins the current mapping for representative messages, so
a change in classification shows up as a failing test.

**First step.** Route-reachable validation failures should throw the typed helpers that already
exist (`badRequest`, `notFound`, `forbidden` and `throwHttp` in `http/errors.ts`). Convert one
route module at a time. Once the routes are typed, change the default for an untyped `Error` to
500 with a generic message.

## 4. Global service locator

`server/src/appServices.ts` exports `services = {} as AppServices`, which `app.ts` fills by
assignment. 24 non-test modules import it, including domain services (`servers/store.ts`,
`schedules/engine.ts`, `nodes/nodeService.ts`, `mods/modService.ts`). `buildAppInstance` spans
most of `app.ts`, and `buildApp` needs a process-wide reservation because building a second app
would overwrite the singleton. Two dependency-injection styles coexist: five route modules read
`services` directly, while auth, schedules, operations and modules receive context objects.

**Why it matters.** Dependencies cannot be seen from function signatures. Tests cannot build two
isolated apps. Boot-order bugs are possible because a module can read a service before `app.ts`
assigns it.

**First step.** Give the five route modules that read `services` a typed container parameter
(start with `appInfoRoutes.ts`, the smallest). Keep `appServices.ts` as a shim until the last
importer is gone. The logger no longer depends on it (see below).

## 5. Two mutation gates

`servers/mutationCoordinator.ts` (`serverMutations`) is the reservation that
`docs/runtime-architecture.md` describes. `exportCoordinator.withMutation` is a second gate that
keeps exports and mutations apart. Routes and lifecycle take `serverMutations` first and the
export gate inside it. The schedule engine (`withScheduleMutation` in `schedules/engine.ts`) takes
only the export gate, and its steps then call lifecycle functions that take `serverMutations`.
`app.ts` passes the export gate to the schedule routes under the name `withServerMutation`.

**Why it matters.** Both gates fail fast today, so this cannot deadlock. Its safety rests on every
new caller knowing two APIs and their order, and the documentation describes only one.

**First step.** Make export exclusion a second lease kind on `ServerMutationCoordinator`, then
remove the direct `exportCoordinator.withMutation` callers. Until then, document the order and
rename the schedule-route parameter.

## 6. The `NodeRuntime` seam is weakly typed and bypassed

Of the methods in `server/src/nodes/types.ts`, 23 return `Promise<unknown>`, so callers cast the
results. At least nine places read `status.docker?.running` with their own casts (for example
`servers/lifecycle.ts`, `runtimeStateCoordinator.ts`, `schedules/engine.ts`,
`routes/serverRoutes.ts` and `nodes/remoteNodeRuntime.ts`). Non-test code has about 54 references
to `localNodeId` or node-ID comparisons, and `mods/modService.ts` checks
`runtime instanceof RemoteNodeRuntime`. `routes/fileRoutes.ts` picks a path separator from the
node type.

**First step.** Give `serverStatus` and `lifecycle` typed results using the shared DTOs, one
method at a time. `runtimeRunning` (now in `runtime/runningState.ts`) is the single reader that
the casts can move to. Replace each `instanceof` check with an optional capability on the
interface.

## 7. Wire types declared on the web side only

About 17 response types exist only in `web/src/types.ts`, among them `ServerStatus`,
`ServerOverviewData`, `PlayerSnapshotsResponse`, `FileListing`, `AuthSession`, `AppState`,
`GeneralJob` and `ModrinthInstallVersionsResponse`. The server builds these shapes without a
return type (`servers/publicViews.ts`, `publicServerStatus`) or with inline casts
(`routes/serverRoutes.ts`, the overview and `/events` handlers). `ServerStorageSummary` shows the
intended pattern: it is declared once in `shared/src/index.ts` and used by both sides.

**First step.** Move the declarations into `shared/` (a mechanical move) and re-export them from
`web/src/types.ts`. Then annotate the server builders with `satisfies` or a return type, one
endpoint at a time.

## 8. Feature state in `App.tsx`

`web/AGENTS.md` asks for feature state to live in `features/<area>/` hooks. `App.tsx` is 2,700
lines with 117 `useState`/`useEffect`/`useRef` calls. The console stream, backlog polling and
reconnect logic form one effect of about 220 lines with its helpers, and they reach into the
overview through `triggerOverviewRefreshRef`. Overview loading, player snapshots and provisioning
job polling also live there. Sixteen `can*` permission flags are computed in `App.tsx` and passed
down as props: `SettingsPage` receives 48 props. Refs mirror state and are written during render
(`consoleTabServerIdRef`, `modulesRef`) or inside a `setLogs` updater.

**First step.** Extract the player-snapshot effect into `features/players/usePlayerSnapshots.ts`.
It is self-contained. Then extract `features/console/useConsoleWorkspace.ts`, which needs
`npm run test:console`. A `useCapabilities` hook can replace the permission props afterwards. Node
management is gated by `users.manage`; a `nodes.*` permission would remove that overload.

## 9. `mods/modService.ts`

At 1,700 lines, this one file holds Modrinth network calls, filesystem work (install temporaries,
jar replacement), preference persistence, module-level caches and pure classification. It has no
dedicated test file. Its coverage comes through `modRequests`, `modEnrichment` and `modHistory`
tests. Export, import and version-switch code still import it for `listModsWithPanelMetadata`,
`batchVersionsFromSha1` and `withRecordedModMutation`.

**First step.** Split it by use case: inventory (list and reconcile), install (install, upload,
replace), update (update and switch) and preferences. Begin with inventory, because the other
parts and `modHistory.ts` depend on it.

## 10. Demo simulation inside production workspaces

`activeServerIsDemo` branches appear 24 times in `useFilesWorkspace.ts`, 21 in
`useModsWorkspace.ts`, 12 in `useFileEditorSession.ts` and 9 in `useSchedulesWorkspace.ts`.
`useModsWorkspace.ts` fakes job progress inline with timers. `App.tsx` passes mutable demo state
(`demoFiles`, `setDemoFiles`, `demoInstalledMods`) into `useFilesWorkspace`.

**First step.** Give each workspace an injected adapter with a real and a demo implementation, so
the hook body has one path. Start with files, which has the most branches.

## 11. Background loops and polling

The server has nine hand-rolled background loops (`resourceStatsCollector.ts`,
`timelineEventCollector.ts`, `playerSnapshots.ts`, `runtimeStateCoordinator.ts`,
`nodes/observationCoordinator.ts`, `players/playerPingCollector.ts`,
`modrinth/updatePlanCoordinator.ts`, `modules/scheduleModule.ts` and the export maintenance
interval in `app.ts`). They use three restart models: a permanent `closed` flag, a generation
counter, and an abort-controller reset. The web app has 19 `setInterval` and 44 `setTimeout`
sites, 17 hand-written `document.hidden` guards, and poll periods hard-coded from 2 s to 60 s.

**First step.** On the server, add an `IntervalWorker` (single in-flight tick, `unref`, a `stop`
that awaits the tick) and migrate one collector, leaving the shutdown order in `app.ts` unchanged.
On the web, add `usePollingEffect(fn, ms, { enabled })` with the hidden-tab and reactivation
handling built in.

## 12. Hand-copied caches

The oldest-entry eviction loop is written five times (`modHashCache.ts`, `modrinth/searchCache.ts`,
`modrinth/compatibility.ts`, `exportInventoryCache.ts` and `players/playerActivityCache.ts`). Some
caches refresh an entry on read (LRU) and `compatibility.ts` does not (FIFO). The in-flight
`set`/`finally(delete)` dedupe pattern appears about eight times.

**First step.** Add `boundedCache.ts` with `setBounded(map, key, value, max, { touchOnRead })`
and `dedupeInFlight(map, key, start)`. Adopt it cache by cache, keeping each one's current
eviction rule unless a change is intended.

## 13. Oversized UI units

`components/ServerTimeline.tsx` (1,600 lines) fetches, polls and merges timeline data inside the
component and contains about 56 pure helpers. Its tests can reach those helpers only through the
component module. `pages/SchedulesPage.tsx` holds step reordering and validation, and
`pages/ServerCreatePage.tsx` holds wizard validation. `pages/VersionSwitchModal.tsx` calls the API
directly. `pages/useServerSettings.ts` is a data hook that sits under `pages/` instead of
`features/`.

**First step.** Extract `useServerTimelineData` and a `timelineMarkers.ts` module. The shared
timeline types already moved out (see below), so the helpers can move without creating a cycle.

## 14. Request cancellation varies by workspace

The web workspaces protect against stale responses in different ways. Mods and nodes use
`createRequestScope`. Users and storage use request-id counters. Files, schedules and players use
`AbortController` only. Export and integration settings use neither. A stale-response fix in one
workspace does not reach the others.

**First step.** Standardize on `createRequestScope` plus `AbortController` (`utils/requestScope.ts`),
starting with the workspaces that have no protection.

## 15. Remaining import cycles

At runtime, the only server cycle left is `mods/modService.ts` ↔ `mods/modHistory.ts`. History
snapshots need `listModsWithPanelMetadata`, and mutations in `modService` record history. Counting
type-only imports, about 31 server modules form one strongly connected component through
`nodes/types.ts` and `appServices.ts`. That cycle has no runtime effect, but it blocks clean
layering.

**First step.** Pass the listing into `readModHistorySnapshot` as an argument, or move snapshot
reading next to the listing as part of item 9.

## Already addressed

These were fixed during the audit without changing behavior, except where noted:

- `mods/modService.ts` no longer hosts pure helpers that core paths borrowed.
  `remoteModMetadata` and `modsFromListResult` moved to `installedModMetadata.ts`, beside the
  strict normalizer they shadow. `runtimeRunning` moved to `runtime/runningState.ts`, and the
  buffered `downloadModrinthJar` moved to `modrinth/jarDownload.ts`. Import, export and the
  operations service no longer load `modService` for these helpers.
- `logging.ts` owns its sink (`setLogSink`) instead of reading `services.appLogger`, so the logger
  that nearly every module imports no longer depends on the composition root.
- `serverLogFields` moved to `servers/serverLogFields.ts`, and `dockerContainerName` moved to
  `storage/serverIdentity.ts`. Routes, schedules and services can now log about a server without
  importing the local Docker runtime.
- The installed-mod snapshot is cleared through `ModUpdatePlanRepository.clearInstalledSnapshot`
  and `StorageDatabase.deleteMetadata`, not raw SQL in `modService`.
- `core.ts` no longer re-exports the cron functions. Callers import them from
  `@serversentinel/contracts`.
- Smaller cleanups: a dead ternary in `servers/store.ts`, and a queue declared above the imports in
  `localRuntimeAdapter.ts`.
- Web: the timeline types moved to `components/timelineTypes.ts`, which breaks the
  component ↔ chart-helper cycle. One `utils/browserStorage.ts` replaces three copies of the
  guarded `localStorage` read and write. The demo storage figures moved into `demo.ts`.
  `useServerContext` no longer parses the URL for a demo fixture outside demo mode.
- Behavior changes (26.11.15): the CSRF header exemption for mod icons now matches only the icon
  route. Previously any GET whose URL contained `/mods/icon` was exempt. Identifying an uploaded
  jar for its icon now hashes the file as a stream instead of reading it whole into memory.
