import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const playwrightInstallCommand = "npx playwright install chromium webkit";

/** Reserves a free loopback port by letting the kernel pick one and releasing it again. */
async function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const listener = createServer();
    listener.once("error", rejectPort);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const selectedPort = typeof address === "object" && address ? address.port : 0;
      listener.close((error) => error ? rejectPort(error) : resolvePort(selectedPort));
    });
  });
}

/**
 * Starts an isolated demo server on a private data directory and resolves once its
 * HTTP listener answers. The returned handle owns both the process and the directory;
 * call `stop()` from a `finally` block to release them.
 */
export async function startDemoHarness({
  dataDirectoryPrefix,
  port,
  mode = "all-in-one",
  env = {},
  readinessTimeoutMs = 30_000
} = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), dataDirectoryPrefix));
  const selectedPort = port ?? await availablePort();
  const baseUrl = `http://127.0.0.1:${selectedPort}`;
  let serverOutput = "";
  let server;

  const stop = async () => {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolveExit) => {
        const onExit = () => {
          clearTimeout(timeout);
          resolveExit();
        };
        const timeout = setTimeout(() => {
          server.off("exit", onExit);
          resolveExit();
        }, 5_000);
        if (server.exitCode === null) server.once("exit", onExit);
        else onExit();
      });
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    await rm(dataDirectory, { recursive: true, force: true });
  };

  try {
    server = spawn(process.execPath, [join(repositoryRoot, "server", "dist", "index.js")], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        LOG_LEVEL: "warn",
        PORT: String(selectedPort),
        SERVERSENTINEL_DATA_DIR: dataDirectory,
        SERVERSENTINEL_ENABLE_DEMO: "true",
        SS_MODE: mode,
        TZ: "UTC",
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    for (const stream of [server.stdout, server.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-20_000); });
    }

    const deadline = Date.now() + readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Demo server stopped before it became ready.\n${serverOutput}`);
      try {
        const response = await fetch(`${baseUrl}/api/auth/session`, { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (response.ok) return { port: selectedPort, baseUrl, dataDirectory, stop };
      } catch {
        // The listener is not ready yet.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw new Error(`Timed out waiting for the demo server at ${baseUrl}.\n${serverOutput}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Launches a Playwright engine, reporting missing browser binaries as an actionable error. */
export async function launchBrowser(engine, options = {}) {
  try {
    return await engine.launch({ headless: true, ...options });
  } catch (error) {
    if (/executable doesn.t exist|browser.*not found|please run/i.test(String(error))) {
      throw new Error(`Playwright browser binaries are missing. Run: ${playwrightInstallCommand}\n${error}`);
    }
    throw error;
  }
}

/**
 * Waits for the authenticated shell to mount. A failure here means demo startup did not
 * provision `demo / demo`, so it is reported as a broken demo rather than a flaky wait.
 */
export async function waitForAppShell(page, timeoutMs = 15_000) {
  try {
    await page.locator(".appShell").waitFor({ timeout: timeoutMs });
  } catch {
    const notice = await page.locator(".notice").textContent().catch(() => "");
    throw new Error(`Demo startup is broken: demo / demo could not sign in.${notice ? ` ${notice.trim()}` : ""}`);
  }
}

/** Signs in through the login form, exercising the same path a real visitor takes. */
export async function signInThroughForm(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username").fill("demo");
  await page.getByLabel("Password").fill("demo");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitForAppShell(page);
}

/** Signs in through the API so the context carries a session before any page loads. */
export async function signInThroughApi(context, baseUrl) {
  const response = await context.request.post(`${baseUrl}/api/auth/login`, {
    headers: { "X-Requested-With": "XMLHttpRequest" },
    data: { username: "demo", password: "demo" }
  });
  if (!response.ok()) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Demo startup is broken: demo / demo could not sign in.${detail ? ` ${detail.trim()}` : ""}`);
  }
}
