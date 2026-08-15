# Branch and release workflow

- `dev` is the default development and integration branch. Start ordinary feature and fix branches from an up-to-date `dev`, and target their pull requests back to `dev`.
- Never commit or push directly to `main`. The `main` branch contains production-ready code only and is protected by GitHub rules.
- Release through a `dev` to `main` pull request after the required CI checks pass. Use a regular merge commit so the long-lived branches retain shared history.
- Production artifacts and deployments must originate only from `main`. The `dev` branch may publish development artifacts, but must not publish production tags such as `latest` or versioned release tags.
- For an urgent production hotfix, branch from `main`, merge the fix into `main` through a pull request, and then synchronize `main` back into `dev`.
- Do not change the default branch, branch rulesets, required checks, or deployment restrictions unless the user explicitly requests it.

# Automatic calendar versioning

- Every completed change to shipped serverSENTINEL behavior must include one calendar version increment in the same change, even when the user does not separately request it.
- Versions use `YY.M.N`: the two-digit year, the month without a leading zero, and a positive release number within that month. For example, the first release in August 2026 is `26.8.1`, followed by `26.8.2`.
- When the current version already uses the year and month in which the change is completed, increment only `N` by one. When the year or month changes, use the new `YY.M` and reset `N` to `1`.
- Fixes, features, breaking changes, performance work, security work, dependency maintenance, and UI polish all advance `N` exactly once; impact no longer selects a major, minor, or patch bump.
- Do not bump again when the version was already raised for the same batch of changes, and follow an explicit version requested by the user when one is provided.
- Do not bump the version for tests-only, documentation-only, CI/tooling-only, comment/formatting, or behavior-preserving refactor changes unless the user explicitly requests it.
- A version bump must synchronize the root, `server`, `shared`, and `web` manifests; `package-lock.json`; internal `@serversentinel/contracts` pins; `server/src/buildInfo.ts`; `web/src/app/appConfig.ts`; `docker/Dockerfile`; and `CHANGELOG.md`. Preserve historical changelog entries and add a concise user-visible note for the new version.
- Run `npm run check:versions` after every bump. Also run validation appropriate to the underlying behavior change and `git diff --check` before handoff.

# Repository structure

- `shared/` contains contracts used by both application sides, `server/` contains the backend and node/runtime integrations, and `web/` contains the React frontend.
- Directory-specific routing lives in `server/AGENTS.md` and `web/AGENTS.md`; follow the scoped file when working in that tree.
- Keep changes narrow and preserve unrelated work. When a contract crosses package boundaries, update the shared definition and all affected consumers together.
- Use the root npm workspace scripts rather than maintaining separate dependency installations in each workspace.
- The `shared/` directory publishes as `@serversentinel/contracts`. Searching for `from "shared` finds nothing; search for `@serversentinel/contracts` instead.
- `shared/` is consumed as built output. Every workspace `build`, `test`, and `typecheck` script rebuilds it first, so a focused test run works from a clean checkout. If an import of `@serversentinel/contracts` fails to resolve, the fix is to build `shared/`, not to edit its `package.json` exports.

# Validation

- Run focused tests while iterating: `npm --workspace server run test -- --run <path>` for backend tests and `npm --workspace web run test -- --run <path>` for frontend tests.
- Before handing off a meaningful change, run the checks appropriate to its scope. The full repository checks are `npm test`, `npm run typecheck`, and `npm run build`.
- Run `git diff --check` before handoff. For responsive or interactive UI changes, also run the relevant browser or mobile smoke verification rather than relying only on unit tests.
- The browser smokes are `npm run test:console`, `npm run test:mobile`, `npm run test:modules`, and `npm run test:overview`. Run `test:modules` for any change to the optional module system (see `docs/modules.md`): it is the only check that can see whether a disabled module's chunk is still downloaded, which no unit test can observe. Run `test:console` for any change to the console, the terminal, or the console stream: what it covers — that the terminal draws output and nothing else, that arriving output leaves the command line alone, and that browsing away and back does not rebuild the console — cannot be seen by unit tests, and each assertion stands for a defect that shipped at least once.

# Automated browser testing

When the application is started with `SERVERSENTINEL_ENABLE_DEMO=true`, always sign in with these fixed credentials:

- Username: `demo`
- Password: `demo`

Never use registration, first-user setup, or the user-management UI to create a testing account. Demo startup owns this account and repairs its password, admin role, full permissions, and server access before the HTTP listener reports ready. If `demo / demo` does not work, treat that as a broken demo startup and report it; do not work around it by creating a user.

Browser scripts under `scripts/` share `scripts/lib/demo-harness.mjs` for port selection, the temporary data directory, demo server startup, readiness polling, sign-in, browser launch, and cleanup. Build new scripts on that harness instead of repeating the lifecycle.

Use a dedicated `SERVERSENTINEL_DATA_DIR` for demo testing. To repair the demo account, invalidate its sessions, and rerun database migrations without deleting other rows, run `npm run demo:reset` with both `SERVERSENTINEL_ENABLE_DEMO=true` and the same `SERVERSENTINEL_DATA_DIR`, then restart or sign in again. Signing out and signing back in also resets the browser-only demo fixtures.

Demo mode is opt-in. Never set `SERVERSENTINEL_ENABLE_DEMO=true` for production data or a production process.
