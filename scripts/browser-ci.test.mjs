import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserCoverage, isDocumentation } from "./browser-ci-changes.mjs";
import { runSuites } from "./browser-ci.mjs";

test("only explicitly allowed documentation paths bypass browsers", () => {
  for (const path of ["README.md", "docs/modules.md", "docs/screenshots/console.png", "scripts/browser-smoke.md", "web/AGENTS.md"]) {
    assert.equal(isDocumentation(path), true, path);
  }
  for (const path of ["web/src/help.md", "web/public/logo.png", "docs/example.js", "package-lock.json", ".github/workflows/dockerpush.yml", "scripts/browser-ci.mjs", "new-file.txt"]) {
    assert.equal(isDocumentation(path), false, path);
  }
});

test("change detection covers entire pushes, merged PRs, deletions, and unavailable history", () => {
  const cwd = mkdtempSync(join(tmpdir(), "serversentinel-ci-changes-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = () => { git("add", "-A"); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  const push = base => browserCoverage({ cwd, eventName: "push", event: { before: base }, ref: "refs/heads/dev" }).required;
  try {
    git("init", "-q");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "ci@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(cwd, "README.md"), "initial");
    writeFileSync(join(cwd, "app.js"), "initial");
    const base = commit();
    writeFileSync(join(cwd, "README.md"), "documentation");
    const docs = commit();
    assert.equal(push(base), false);
    const dispatch = comparison => browserCoverage({ cwd, eventName: "workflow_dispatch", event: { inputs: { browser_comparison_base: comparison } } }).required;
    assert.equal(dispatch(base), false, "screenshot automation can compare against its captured base");
    assert.equal(browserCoverage({ cwd, eventName: "push", event: { before: base }, ref: "refs/heads/main" }).required, true);
    assert.equal(browserCoverage({ cwd, eventName: "pull_request", event: { pull_request: { base: { sha: base } } }, ref: "refs/pull/1/merge" }).required, false);
    writeFileSync(join(cwd, "app.js"), "behavior");
    commit();
    writeFileSync(join(cwd, "README.md"), "more documentation");
    const tip = commit();
    assert.equal(push(docs), true, "earlier application commits must not be hidden by the last docs commit");
    assert.equal(dispatch(base), true, "dispatch input cannot bypass application changes");
    assert.equal(browserCoverage({ cwd, eventName: "pull_request", event: { pull_request: { base: { sha: base } } } }).required, true);
    mkdirSync(join(cwd, "docs"));
    renameSync(join(cwd, "app.js"), join(cwd, "docs", "example.md"));
    commit();
    assert.equal(push(tip), true, "renaming code into documentation still removes code");
    assert.equal(push(git("rev-parse", "HEAD")), true, "empty diffs fail closed");
    assert.equal(push("0".repeat(40)), true);
    assert.equal(push("f".repeat(40)), true);
    assert.equal(push("--invalid"), true);
    assert.equal(browserCoverage({ cwd, eventName: "workflow_dispatch", event: {} }).required, true);
    assert.equal(browserCoverage({ cwd, eventName: "push", event: { before: base }, ref: "refs/heads/main" }).required, true);
    assert.equal(browserCoverage({ cwd, eventName: "pull_request", event: {} }).required, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runner bounds concurrency, reports failures, and waits for remaining suites", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "serversentinel-ci-runner-"));
  try {
    writeFileSync(join(cwd, "fixture.mjs"), `
      import { appendFileSync, existsSync, writeFileSync } from "node:fs";
      const id = process.argv[2];
      appendFileSync("events", "start " + id + "\\n");
      writeFileSync(id + ".started", "");
      if (id !== "third") {
        const deadline = Date.now() + 5000;
        while (!existsSync("first.started") || !existsSync("second.started")) {
          if (Date.now() > deadline) throw new Error("Suites did not run concurrently");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      appendFileSync("events", "end " + id + "\\n");
      writeFileSync(id + ".finished", "");
      process.exitCode = id === "first" ? 7 : 0;
    `);
    const failures = await runSuites([
      ["failure", "fixture.mjs", "first"],
      ["success", "fixture.mjs", "second"],
      ["later", "fixture.mjs", "third"],
      ["missing", "missing.mjs"]
    ], { cwd, concurrency: 2 });
    assert.deepEqual(failures.sort(), ["failure", "missing"]);
    const events = readFileSync(join(cwd, "events"), "utf8").trim().split("\n");
    let active = 0;
    let peak = 0;
    for (const event of events) {
      active += event.startsWith("start ") ? 1 : -1;
      peak = Math.max(active, peak);
      assert(active >= 0 && active <= 2);
    }
    assert.equal(peak, 2);
    assert.equal(active, 0);
    for (const id of ["first", "second", "third"]) readFileSync(join(cwd, `${id}.finished`));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
