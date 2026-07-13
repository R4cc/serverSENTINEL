# Automated browser testing

When the application is started with `SERVERSENTINEL_ENABLE_DEMO=true`, always sign in with these fixed credentials:

- Username: `demo`
- Password: `demo`

Never use registration, first-user setup, or the user-management UI to create a testing account. Demo startup owns this account and repairs its password, admin role, full permissions, and server access before the HTTP listener reports ready. If `demo / demo` does not work, treat that as a broken demo startup and report it; do not work around it by creating a user.

Use a dedicated `SERVERSENTINEL_DATA_DIR` for demo testing. To repair the demo account, invalidate its sessions, and rerun database migrations without deleting other rows, run `npm run demo:reset` with both `SERVERSENTINEL_ENABLE_DEMO=true` and the same `SERVERSENTINEL_DATA_DIR`, then restart or sign in again. Signing out and signing back in also resets the browser-only demo fixtures.

Demo mode is opt-in. Never set `SERVERSENTINEL_ENABLE_DEMO=true` for production data or a production process.
