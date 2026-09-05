import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Only known documentation locations qualify. New/unknown paths require coverage.
export function isDocumentation(path) {
  return ["README.md", "CHANGELOG.md", "AGENTS.md", "server/AGENTS.md", "web/AGENTS.md"].includes(path)
    || /^docs\/.+\.md$/.test(path)
    || /^docs\/screenshots\/[^/]+\.png$/.test(path)
    || /^scripts\/[^/]+\.md$/.test(path);
}

export function browserCoverage({ eventName, event, ref, cwd = process.cwd() }) {
  if (ref === "refs/heads/main") {
    return { required: true, reason: "Production pushes always run browser coverage." };
  }
  const base = eventName === "pull_request" ? event?.pull_request?.base?.sha
    : eventName === "push" ? event?.before
    : eventName === "workflow_dispatch" ? event?.inputs?.browser_comparison_base : undefined;
  if (!base || !/^[a-f0-9]{40}$/i.test(base) || /^0+$/.test(base)) {
    return { required: true, reason: "No reliable comparison base; running browser coverage." };
  }
  try {
    // For PRs HEAD is GitHub's test merge; otherwise it is the checked-out branch tip.
    // Disable rename detection so moving application code into docs cannot hide its removal.
    const paths = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
    }).split("\0").filter(Boolean);
    const required = paths.length === 0 || paths.some(path => !isDocumentation(path));
    return { required, reason: required ? "Application, tooling, unknown, or empty changeset; running browser coverage."
      : `Only documentation/screenshots changed (${paths.length} paths); skipping browser coverage.` };
  } catch {
    return { required: true, reason: "Comparison unavailable; running browser coverage." };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let event = {};
  try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")); } catch { /* Fail closed below. */ }
  const result = browserCoverage({ eventName: process.env.GITHUB_EVENT_NAME, event, ref: process.env.GITHUB_REF });
  console.log(result.reason);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `required=${result.required}\n`);
}
