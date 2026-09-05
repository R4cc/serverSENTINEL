# Browser regression gate

The `ci` workflow runs `npm run test:browser:ci` on pull requests to `dev` and
`main`, pushes to either branch, and manual runs. Documentation/screenshot-only
PRs and pushes to `dev` skip browser installation and execution; default manual runs and
pushes to `main` always run them. A failed smoke fails the existing
`ci` check before Docker publishing. Branch protection requires that check on
`main`; the workflow also reports it on PRs to `dev`.

Change detection compares the complete push or PR against its base, with full
checkout history. Only the explicit documentation allowlist in
`scripts/browser-ci-changes.mjs` can skip coverage. Application, dependency,
workflow, script, unknown-path, empty-diff, and unavailable-base changes run it.
The existing `ci` check still runs for documentation changes, including unit tests,
typechecking, and the Docker build on pushes/PRs.

The screenshot automation dispatches CI with `browser_comparison_base` set to
the commit used to capture the screenshots. CI verifies the diff against that
commit using the same allowlist. Dispatches without that optional input run the
browser gate; missing/invalid comparison commits also run it. Runs on `main`
always run the gate, regardless of the input.

The focused suite builds the production app once, then runs two smoke scripts at
a time against their own demo servers. The longer console-loading and mobile
suites start first. Every suite finishes (including cleanup) even if another
fails; any failure fails the gate. Output is prefixed with the suite name and
each suite reports its duration. The suite includes:

- `loading-workflows-smoke.mjs`: Overview storage refresh/recovery, cached Files
  navigation, overlapping reads, server switches, and permission denial.
- `console-smoke.mjs`: command input, ordered output, scrollback, renderer
  stability, and terminal survival across navigation at desktop/mobile sizes.
- `console-loading-smoke.mjs`: empty through 25,000-line backlogs at two widths,
  reconnect cursors, retained drafts/terminal instances, overlapping output,
  epoch replacement, and server switches.
- `mobile-ui-smoke.mjs --navigation-only`: Chromium/WebKit navigation, restored pages, responsive
  layouts, and console viewport/keyboard behavior.

Install the locked npm dependencies and browser binaries before running locally:

```sh
npm ci
npx playwright install --with-deps --only-shell chromium webkit
npm run test:browser:ci
```

Installation keeps Chromium's headless shell and WebKit, omitting the unused full
Chromium browser. CI sets `CONSOLE_LOADING_REPEATS=1` to exercise every backlog/width scenario once.
Local runs default to three repetitions. This changes repetition count only;
all regression assertions remain enabled. The browser step has a 15-minute
timeout and does not retry or ignore failures; assertion diagnostics appear in
the Actions log. Each script uses the shared demo harness, a temporary data
directory, and the fixed `demo / demo` account.

`npm run test:smoke` remains the broader suite, adding optional-module, detailed
Overview timeline, search, and full mobile coverage (including player-map
interactions). Individual `test:console`, `test:loading`,
`test:mobile`, `test:modules`, `test:overview`, and `test:search` commands remain
available for focused work.
