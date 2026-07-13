# README screenshots

These images are generated; do not edit them by hand.

Run `npm run screenshots:update` to rebuild the application, start it in demo mode with a fresh temporary data directory, sign in with `demo / demo`, and replace the screenshots. Install the matching local browser once with `npx playwright install chromium` if needed.

The `README screenshots` GitHub Actions workflow uses a pinned Playwright container and opens or updates `automation/readme-screenshots` when the generated PNGs change. The existing CI workflow is dispatched on that branch so normal checks and review rules still apply before the images reach `main`.

GitHub Actions must have read/write workflow permissions and permission to create pull requests in the repository's **Settings → Actions → General** page. No long-lived personal access token is required.
