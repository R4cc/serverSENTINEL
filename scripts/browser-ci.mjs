import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { appendFileSync } from "node:fs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
// Approximate seconds from CI timings, used only for scheduling. Cohesion now
// includes the spacing assertions during the same page/dialog visits.
const suites = [
  [3, "server-settings", "scripts/server-settings-smoke.mjs"],
  [46, "properties-ui", "scripts/properties-ui-smoke.mjs"],
  [103, "schedules-ui", "scripts/schedules-ui-smoke.mjs"],
  [29, "nodes-ui", "scripts/nodes-ui-smoke.mjs"],
  [5, "files-workspace", "scripts/files-workspace-smoke.mjs"],
  [38, "console-loading", "scripts/console-loading-smoke.mjs"],
  [71, "mobile-navigation", "scripts/mobile-ui-smoke.mjs", "--navigation-only"],
  [24, "console", "scripts/console-smoke.mjs"],
  [15, "loading-workflows", "scripts/loading-workflows-smoke.mjs"],
  [30, "micro-motion", "scripts/micro-motion-smoke.mjs"],
  [12, "toast-progress", "scripts/toast-progress-smoke.mjs"],
  [18, "performance", "scripts/performance-smoke.mjs"],
  [61, "overview-mods", "scripts/overview-mods-polish-smoke.mjs"],
  [19, "ui-consistency", "scripts/ui-consistency-smoke.mjs"],
  [120, "ui-cohesion", "scripts/ui-cohesion-smoke.mjs"]
];

export function selectSuites(shard = "1/1") {
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || index > count || count > suites.length) {
    throw new Error(`Invalid browser shard ${shard}; use INDEX/COUNT with 1 <= INDEX <= COUNT <= ${suites.length}`);
  }
  const groups = Array.from({ length: count }, () => ({ seconds: 0, entries: [] }));
  for (const [seconds, ...entry] of [...suites].sort((a, b) => b[0] - a[0])) {
    const group = groups.reduce((best, candidate) => candidate.seconds < best.seconds ? candidate : best);
    group.seconds += seconds;
    group.entries.push(entry);
  }
  return groups[index - 1].entries;
}

export async function runSuites(entries, { concurrency = 2, cwd = repositoryRoot } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer");
  const pending = [...entries];
  const failures = [];
  async function worker() {
    while (pending.length) {
      const [name, ...args] = pending.shift();
      const started = Date.now();
      console.log(`[${name}] Starting`);
      const passed = await new Promise(resolveRun => {
        const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
        for (const [stream, write] of [[child.stdout, console.log], [child.stderr, console.error]]) {
          createInterface({ input: stream }).on("line", line => write(`[${name}] ${line}`));
        }
        child.once("error", error => { console.error(`[${name}] ${error.message}`); resolveRun(false); });
        child.once("close", code => resolveRun(code === 0));
      });
      console.log(`[${name}] ${passed ? "Passed" : "FAILED"} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      if (!passed) failures.push(name);
    }
  }
  // Let every script finish its harness cleanup, even when another suite fails.
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { shard: { type: "string", default: "1/1" } } });
  const entries = selectSuites(values.shard);
  const started = Date.now();
  console.log(`Browser shard ${values.shard}: ${entries.map(([name]) => name).join(", ")}`);
  const failures = await runSuites(entries);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Browser shard ${values.shard} finished in ${seconds}s (${failures.length} failed).`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Browser shard ${values.shard}\n\n${entries.length} suites in ${seconds}s; ${failures.length} failed.\n\n${entries.map(([name]) => `- ${name}`).join("\n")}\n`);
  if (failures.length) {
    console.error(`Browser regression gate failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}
