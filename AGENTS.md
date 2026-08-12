# Branch and release workflow

- `dev` is the default development and integration branch. Start ordinary feature and fix branches from an up-to-date `dev`, and target their pull requests back to `dev`.
- Never commit or push directly to `main`. The `main` branch contains production-ready code only and is protected by GitHub rules.
- Release through a `dev` to `main` pull request after the required CI checks pass. Use a regular merge commit so the long-lived branches retain shared history.
- Production artifacts and deployments must originate only from `main`. The `dev` branch may publish development artifacts, but must not publish production tags such as `latest` or versioned release tags.
- For an urgent production hotfix, branch from `main`, merge the fix into `main` through a pull request, and then synchronize `main` back into `dev`.
- Do not change the default branch, branch rulesets, required checks, or deployment restrictions unless the user explicitly requests it.

# Automatic versioning

- Every completed change to shipped serverSENTINEL behavior must include one SemVer version bump in the same change, even when the user does not separately request a version bump. Determine the bump from the highest-impact change in the task:
  - **Patch (`x.y.Z`)** for backward-compatible bug fixes, performance improvements, security hardening, dependency maintenance, and user-interface polish that does not add a distinct capability.
  - **Minor (`x.Y.0`)** for backward-compatible features, new user-visible capabilities, new optional protocol capabilities, and additive API or export-schema functionality.
  - **Major (`X.0.0`)** for explicitly authorized breaking changes to supported APIs, protocols, stored data, configuration, or user workflows. Do not introduce or infer a breaking change merely to justify a major bump.
- Use only the highest applicable bump once per task. Do not bump again when the current version was already raised for the same batch of changes, and follow an explicit version requested by the user when one is provided.
- Do not bump the version for tests-only, documentation-only, CI/tooling-only, comment/formatting, or behavior-preserving refactor changes unless the user explicitly requests it.
- A version bump must synchronize the root, `server`, `shared`, and `web` manifests; `package-lock.json`; internal `@serversentinel/contracts` pins; `server/src/buildInfo.ts`; `web/src/app/appConfig.ts`; `docker/Dockerfile`; and `CHANGELOG.md`. Preserve historical changelog entries and add a concise user-visible note for the new version.
- Run `npm run check:versions` after every bump. Also run validation appropriate to the underlying behavior change and `git diff --check` before handoff.

# Repository structure

- `shared/` contains contracts used by both application sides, `server/` contains the backend and node/runtime integrations, and `web/` contains the React frontend.
- Keep changes narrow and preserve unrelated work. When a contract crosses package boundaries, update the shared definition and all affected consumers together.
- Use the root npm workspace scripts rather than maintaining separate dependency installations in each workspace.
- The `shared/` directory publishes as `@serversentinel/contracts`. Searching for `from "shared` finds nothing; search for `@serversentinel/contracts` instead. `web/src/types.ts` re-exports most of it, so a type used in the frontend is usually defined in `shared/src/index.ts`.
- `shared/` is consumed as built output. Every workspace `build`, `test`, and `typecheck` script rebuilds it first, so a focused test run works from a clean checkout. If an import of `@serversentinel/contracts` fails to resolve, the fix is to build `shared/`, not to edit its `package.json` exports.

# Where the frontend lives

- `web/src/App.tsx` is the state hub: authentication, navigation, the active server, and the console pipeline. It owns the app-level effects and passes state down as props, so most page changes also touch it.
- `web/src/features/<area>/use<Area>Workspace.ts` owns per-area state and data loading for files, mods, nodes, schedules, settings, and users. Prefer changing the workspace hook over adding state to `App.tsx`.
- `web/src/app/` holds shell concerns split out of `App.tsx` (config, navigation storage, workspace guards, display formatters). `web/src/utils/` holds pure helpers that are unit tested in isolation.
- Pages under `web/src/pages/` are largely presentational and receive their state as props.

# Stylesheets

Styles are global CSS, not modules, so cascade order is load-bearing. `web/src/styles.css` is the entry point and its `@import` order is the contract; `web/src/styles.test.ts` asserts it.

Each stylesheet owns a class family. Change a rule in its owning file rather than overriding it downstream:

| Stylesheet | Owns |
| --- | --- |
| `tokens.css`, `themes.css`, `fonts.css` | Custom properties, theme surfaces, font faces |
| `typography.css` | Type scale applied to shell and form elements |
| `primitives.css` | The `ui*` primitives (`uiButton`, `uiMetricTile`, `uiPanelHeader`, `uiSurface`) and loading skeletons |
| `canonical-layout.css` | Cross-page shell geometry: `workspaceHeader`, sidebar collapse, server strip |
| `layout.css` | Shell chrome: `activeServerStrip`, `runtimeBadge`, toasts, users table |
| `overview.css` | Overview page and the server timeline |
| `mods.css` | `modsWorkspace*`, mod drawers and compatibility cards |
| `file-manager.css` | `filesPage` and file tables |
| `files-console.css` | Terminal, file editor, mod install version rows |
| `schedules.css` | Schedule tables, runs, and steps |
| `settings.css` | `settingsHub*` |
| `settings-nodes.css` | Node create wizard, node drawer, `summaryTile` |
| `nodes.css` | Nodes list page; loads after `responsive.css` and owns its layout end to end |
| `server-properties.css` | Properties form and danger panel |
| `auth.css`, `confirmation-modal.css` | Sign-in and confirmation dialogs |
| `responsive.css` | Shared shell breakpoints and cross-feature responsive primitives |
| `motion.css` | Transitions and animation |

- Put a feature's responsive rules in that feature's stylesheet next to the base rule. `responsive.css` is only for shell-wide and cross-feature primitive breakpoints; adding a feature-owned selector there creates competing owners and is rejected by `styles.test.ts`.
- Feature stylesheets must use theme tokens, not raw hex or `rgb()` values, and must not redefine `ui*` primitives.
- `styles.test.ts` asserts ownership, cascade order, and retired class names. It deliberately does not assert declaration values — do not add regexes that pin pixel sizes, colors, or property order, because they cannot verify rendering and break on reformatting. Verify visual behaviour with the smoke scripts instead.

# Validation

- Run focused tests while iterating: `npm --workspace server run test -- --run <path>` for backend tests and `npm --workspace web run test -- --run <path>` for frontend tests.
- Before handing off a meaningful change, run the checks appropriate to its scope. The full repository checks are `npm test`, `npm run typecheck`, and `npm run build`.
- Run `git diff --check` before handoff. For responsive or interactive UI changes, also run the relevant browser or mobile smoke verification rather than relying only on unit tests.
- The browser smokes are `npm run test:console`, `npm run test:mobile`, and `npm run test:overview`. Run `test:console` for any change to the console, the terminal, or the console stream: what it covers — that the terminal draws output and nothing else, that arriving output leaves the command line alone, and that browsing away and back does not rebuild the console — cannot be seen by unit tests, and each assertion stands for a defect that shipped at least once.

# Automated browser testing

When the application is started with `SERVERSENTINEL_ENABLE_DEMO=true`, always sign in with these fixed credentials:

- Username: `demo`
- Password: `demo`

Never use registration, first-user setup, or the user-management UI to create a testing account. Demo startup owns this account and repairs its password, admin role, full permissions, and server access before the HTTP listener reports ready. If `demo / demo` does not work, treat that as a broken demo startup and report it; do not work around it by creating a user.

Browser scripts under `scripts/` share `scripts/lib/demo-harness.mjs` for port selection, the temporary data directory, demo server startup, readiness polling, sign-in, browser launch, and cleanup. Build new scripts on that harness instead of repeating the lifecycle.

Use a dedicated `SERVERSENTINEL_DATA_DIR` for demo testing. To repair the demo account, invalidate its sessions, and rerun database migrations without deleting other rows, run `npm run demo:reset` with both `SERVERSENTINEL_ENABLE_DEMO=true` and the same `SERVERSENTINEL_DATA_DIR`, then restart or sign in again. Signing out and signing back in also resets the browser-only demo fixtures.

Demo mode is opt-in. Never set `SERVERSENTINEL_ENABLE_DEMO=true` for production data or a production process.
