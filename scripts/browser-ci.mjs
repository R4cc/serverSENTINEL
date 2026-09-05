import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const suites = [
  ["console-loading", "scripts/console-loading-smoke.mjs"],
  ["mobile-navigation", "scripts/mobile-ui-smoke.mjs", "--navigation-only"],
  ["console", "scripts/console-smoke.mjs"],
  ["loading-workflows", "scripts/loading-workflows-smoke.mjs"]
];

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
  const failures = await runSuites(suites);
  if (failures.length) {
    console.error(`Browser regression gate failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}
