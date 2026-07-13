import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "../permissions.js";
import { currentSchemaVersion } from "../storage/database.js";

type RunningDemo = {
  baseUrl: string;
  child: ChildProcess;
  dataDir: string;
  output: () => string;
};

const running = new Set<RunningDemo>();
const temporaryDirectories = new Set<string>();

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function requestHeaders(baseUrl: string, cookie?: string) {
  return {
    "X-Requested-With": "XMLHttpRequest",
    Origin: baseUrl,
    ...(cookie ? { Cookie: cookie } : {})
  };
}

async function waitUntilReady(instance: RunningDemo, demoEnabled = true) {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null) {
      throw new Error(`Demo server exited before readiness.\n${instance.output()}`);
    }
    try {
      const response = await fetch(`${instance.baseUrl}/api/auth/session`, {
        headers: requestHeaders(instance.baseUrl)
      });
      if (response.ok) {
        const session = await response.json() as { setupRequired: boolean; demoEnabled?: boolean };
        expect(session).toMatchObject({ setupRequired: !demoEnabled, demoEnabled });
        return;
      }
      lastError = new Error(`Readiness returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for demo readiness: ${String(lastError)}\n${instance.output()}`);
}

async function startDemo(dataDir?: string, demoEnabled = true) {
  const resolvedDataDir = dataDir ?? await mkdtemp(join(tmpdir(), "serversentinel-demo-test-"));
  temporaryDirectories.add(resolvedDataDir);
  const port = await freePort();
  const chunks: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      SS_MODE: "all-in-one",
      LOG_LEVEL: "warn",
      SERVERSENTINEL_DATA_DIR: resolvedDataDir,
      SERVERSENTINEL_ENABLE_DEMO: String(demoEnabled),
      SERVERSENTINEL_SERVERS_DOCKER_VOLUME: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr?.on("data", (chunk) => chunks.push(String(chunk)));
  const instance = { baseUrl: `http://127.0.0.1:${port}`, child, dataDir: resolvedDataDir, output: () => chunks.join("") };
  running.add(instance);
  await waitUntilReady(instance, demoEnabled);
  return instance;
}

async function stopDemo(instance: RunningDemo) {
  if (instance.child.exitCode === null) {
    instance.child.kill();
    await Promise.race([
      new Promise<void>((resolve) => instance.child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000))
    ]);
    if (instance.child.exitCode === null) instance.child.kill("SIGKILL");
  }
  running.delete(instance);
}

async function login(instance: RunningDemo) {
  const response = await fetch(`${instance.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      ...requestHeaders(instance.baseUrl),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ username: "demo", password: "demo" })
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const session = await response.json() as {
    authenticated: boolean;
    demo: boolean;
    user: { id: string; username: string; rolePreset: string; permissions: string[]; serverAccess?: { mode: string } };
  };
  expect(session).toMatchObject({
    authenticated: true,
    demo: true,
    user: { username: "demo", rolePreset: "admin", serverAccess: { mode: "all" } }
  });
  expect(session.user.permissions).toEqual(ALL_PERMISSIONS);

  const appResponse = await fetch(`${instance.baseUrl}/api/app`, {
    headers: requestHeaders(instance.baseUrl, cookie)
  });
  expect(appResponse.status).toBe(200);
  expect(await appResponse.json()).toMatchObject({ servers: [], nodes: [] });

  const authenticatedSession = await fetch(`${instance.baseUrl}/api/auth/session`, {
    headers: requestHeaders(instance.baseUrl, cookie)
  });
  expect(await authenticatedSession.json()).toMatchObject({ authenticated: true, demo: true, user: { username: "demo" } });
  return session.user;
}

afterEach(async () => {
  await Promise.all([...running].map(stopDemo));
  await Promise.all([...temporaryDirectories].map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }));
});

describe.sequential("demo-mode startup and authentication", () => {
  it("does not seed or expose demo mode when the production-default flag is disabled", async () => {
    const instance = await startDemo(undefined, false);
    const database = new Database(join(instance.dataDir, "serversentinel.sqlite"), { readonly: true });
    try {
      expect(database.prepare("SELECT count(*) AS count FROM users").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  }, 30_000);

  it("migrates a clean database, seeds the documented user before readiness, and grants all page permissions", async () => {
    const instance = await startDemo();
    await login(instance);

    const database = new Database(join(instance.dataDir, "serversentinel.sqlite"), { readonly: true });
    try {
      const schema = database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number };
      expect(schema.version).toBe(currentSchemaVersion);
      expect(database.prepare("SELECT count(*) AS count FROM users WHERE username = 'demo' COLLATE NOCASE").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  }, 30_000);

  it("repairs stale credentials, role, permissions, and server access in an existing demo database", async () => {
    const first = await startDemo();
    const originalUser = await login(first);
    await stopDemo(first);

    const databasePath = join(first.dataDir, "serversentinel.sqlite");
    const database = new Database(databasePath);
    try {
      database.prepare(`
        UPDATE users SET password_hash = 'stale', salt = 'stale', role_preset = 'viewer',
          permissions_json = '["broken.permission"]', server_access_json = '{"mode":"selected","serverIds":[]}'
        WHERE username = 'demo' COLLATE NOCASE
      `).run();
    } finally {
      database.close();
    }

    const restarted = await startDemo(first.dataDir);
    const repairedUser = await login(restarted);
    expect(repairedUser.id).toBe(originalUser.id);
  }, 30_000);
});
