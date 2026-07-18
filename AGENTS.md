# Branch and release workflow

- `dev` is the default development and integration branch. Start ordinary feature and fix branches from an up-to-date `dev`, and target their pull requests back to `dev`.
- Never commit or push directly to `main`. The `main` branch contains production-ready code only and is protected by GitHub rules.
- Release through a `dev` to `main` pull request after the required CI checks pass. Use a regular merge commit so the long-lived branches retain shared history.
- Production artifacts and deployments must originate only from `main`. The `dev` branch may publish development artifacts, but must not publish production tags such as `latest` or versioned release tags.
- For an urgent production hotfix, branch from `main`, merge the fix into `main` through a pull request, and then synchronize `main` back into `dev`.
- Do not change the default branch, branch rulesets, required checks, or deployment restrictions unless the user explicitly requests it.

# Repository structure

- `shared/` contains contracts used by both application sides, `server/` contains the backend and node/runtime integrations, and `web/` contains the React frontend.
- Keep changes narrow and preserve unrelated work. When a contract crosses package boundaries, update the shared definition and all affected consumers together.
- Use the root npm workspace scripts rather than maintaining separate dependency installations in each workspace.

# Validation

- Run focused tests while iterating: `npm --workspace server run test -- --run <path>` for backend tests and `npm --workspace web run test -- --run <path>` for frontend tests.
- Before handing off a meaningful change, run the checks appropriate to its scope. The full repository checks are `npm test`, `npm run typecheck`, and `npm run build`.
- Run `git diff --check` before handoff. For responsive or interactive UI changes, also run the relevant browser or mobile smoke verification rather than relying only on unit tests.

# Automated browser testing

When the application is started with `SERVERSENTINEL_ENABLE_DEMO=true`, always sign in with these fixed credentials:

- Username: `demo`
- Password: `demo`

Never use registration, first-user setup, or the user-management UI to create a testing account. Demo startup owns this account and repairs its password, admin role, full permissions, and server access before the HTTP listener reports ready. If `demo / demo` does not work, treat that as a broken demo startup and report it; do not work around it by creating a user.

Use a dedicated `SERVERSENTINEL_DATA_DIR` for demo testing. To repair the demo account, invalidate its sessions, and rerun database migrations without deleting other rows, run `npm run demo:reset` with both `SERVERSENTINEL_ENABLE_DEMO=true` and the same `SERVERSENTINEL_DATA_DIR`, then restart or sign in again. Signing out and signing back in also resets the browser-only demo fixtures.

Demo mode is opt-in. Never set `SERVERSENTINEL_ENABLE_DEMO=true` for production data or a production process.
