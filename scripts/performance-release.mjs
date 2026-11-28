import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { on, once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";
import { launchBrowser, repositoryRoot, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

const [scenario, repeatArgument, idleArgument] = process.argv.slice(2);
assert.ok(["panel", "node", "fleet", "browser", "size"].includes(scenario),
  "Usage: node scripts/performance-release.mjs panel|node|fleet|browser|size [repeats] [idle-seconds]");
const repeats = Number(repeatArgument ?? 1);
const idleSeconds = Number(idleArgument ?? (scenario === "browser" ? 25 : 0));
assert.ok(Number.isSafeInteger(repeats) && repeats > 0 && Number.isFinite(idleSeconds) && idleSeconds >= 0);
const round = (value) => Number(value.toFixed(2));
const report = (metrics) => console.log(JSON.stringify({ scenario, node: process.version, ...metrics }));

async function listen(server, ...args) {
  server.listen(...args);
  await once(server, "listening");
  return server.address();
}

async function treeBytes(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const sizes = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => ({
    name: entry.name,
    bytes: (await stat(join(entry.parentPath, entry.name))).size
  })));
  return {
    bytes: sizes.reduce((total, entry) => total + entry.bytes, 0),
    jsBytes: sizes.filter(({ name }) => name.endsWith(".js")).reduce((total, entry) => total + entry.bytes, 0)
  };
}

async function browserTrials() {
  const demo = await startDemoHarness({ dataDirectoryPrefix: "sentinel-release-browser-", env: {
    NODE_ENV: "production", DOCKER_SOCKET: "/dev/null/docker.sock", MAXMIND_ACCOUNT_ID: "", MAXMIND_LICENSE_KEY: ""
  } });
  let browser;
  try {
    browser = await launchBrowser(chromium);
    for (let trial = 1; trial <= repeats; trial++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 990 } });
      try {
        await signInThroughApi(context, demo.baseUrl);
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
        const started = performance.now();
        await page.goto(demo.baseUrl, { waitUntil: "domcontentloaded" });
        await page.locator('.serverTimelinePanel[aria-busy="false"] .serverTimelineEChart svg').first().waitFor();
        const overviewMs = round(performance.now() - started);
        // Allow initial rendering to settle while starting well before the old 10s preload.
        await delay(2_000);
        const startTime = await page.evaluate(() => performance.now());
        const readMetrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
        const before = await readMetrics();
        await delay(idleSeconds * 1_000);
        const after = await readMetrics();
        await cdp.send("HeapProfiler.collectGarbage");
        const retained = await readMetrics();
        const activity = await page.evaluate((from) => {
          const assets = performance.getEntriesByType("resource").filter((entry) => {
            const url = new URL(entry.name);
            return entry.startTime >= from && url.pathname.startsWith("/assets/") && /\.(js|css)$/.test(url.pathname);
          });
          return {
            idleCodeRequests: assets.length,
            idleCodeBytes: assets.reduce((total, entry) => total + entry.encodedBodySize, 0)
          };
        }, startTime);
        const navigationStarted = performance.now();
        await page.getByTitle("Open console", { exact: true }).click();
        await page.locator(".minecraftTerminal:not(.initializing)").waitFor();
        report({ trial, idleSeconds, overviewMs, firstConsoleMs: round(performance.now() - navigationStarted), ...activity,
          idleMainThreadCpuMs: round((after.TaskDuration - before.TaskDuration) * 1_000),
          retainedJsHeapMiB: round(retained.JSHeapUsedSize / 1024 ** 2) });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await demo.stop();
  }
}

const fleetSize = 12;
const fixtureSession = "benchmark-session";

async function seedFleet(directory) {
  const { openStorageDatabase } = await import("../server/dist/storage/database.js");
  const storage = openStorageDatabase(join(directory, "serversentinel.sqlite"));
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const servers = new Map();
  try {
    for (let index = 0; index < fleetSize; index++) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const path = join(directory, "servers", id);
      await mkdir(join(path, "logs"), { recursive: true });
      await writeFile(join(path, "logs", "latest.log"), "");
      servers.set(id, path);
    }
    storage.transaction((db) => {
      db.exec("INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at) VALUES ('local', 'Local', 'local', 'online', 1, '', '')");
      db.prepare(`INSERT INTO users (id, username, password_hash, salt, role_preset, permissions_json, created_at, updated_at)
        VALUES ('benchmark-user', 'benchmark', 'unused', 'unused', 'custom', '["servers.view"]', ?, ?)`).run(timestamp, timestamp);
      db.prepare("INSERT INTO sessions VALUES (?, 'benchmark-user', ?)").run(fixtureSession, timestamp);
      const server = db.prepare(`INSERT INTO servers (id, node_id, display_name, server_dir,
        runtime_profile_json, docker_container, runtime_intent, created_at, updated_at, crash_stable_since)
        VALUES (?, 'local', ?, ?, ?, ?, 'running', ?, ?, ?)`);
      const sample = db.prepare("INSERT INTO resource_stats VALUES (?, ?, ?)");
      const profile = JSON.stringify({ minecraftVersion: "1.21.4", runtimeType: "fabric", runtimeVersion: "0.16.10",
        javaMajorVersion: 21, jarProvider: "mcjars", jarArtifact: { filename: "fabric-server-launch.jar" }, resolvedAt: timestamp });
      for (const [id, path] of servers) {
        server.run(id, id, path, profile, id, timestamp, timestamp, timestamp);
        for (let index = 720; index > 0; index--) {
          const sampledAt = now - index * 5_000;
          sample.run(id, sampledAt, JSON.stringify({ sampledAt, readAt: new Date(sampledAt).toISOString(),
            available: true, running: true, cpuPercent: 20, memoryUsageBytes: 1024 ** 3, memoryLimitBytes: 4 * 1024 ** 3,
            playersOnline: 50, playerPingMs: Array.from({ length: 50 }, (_, player) => 20 + player) }));
        }
      }
    });
  } finally {
    storage.close();
  }
  return servers;
}

async function checkFleetEndpoints(port, serverId) {
  const base = `http://127.0.0.1:${port}/api/servers/${serverId}`;
  const headers = { "X-Requested-With": "XMLHttpRequest", cookie: `serversentinel_session=${fixtureSession}` };
  const read = async (path) => {
    const response = await fetch(`${base}/${path}`, { headers });
    assert.equal(response.status, 200, `Fixture could not read ${path}`);
    return response.json();
  };
  const status = await read("status");
  assert.equal(status.docker.running, true);
  assert.equal(status.commandInputAvailable, true);
  const historyStarted = performance.now();
  const { samples } = await read("stats/history");
  const historyMs = round(performance.now() - historyStarted);
  assert.ok(samples.length > 700 && samples.some((sample) => sample.playerPingMs?.length === 50));
  return { historyMs, historySamples: samples.length };
}

function dockerFixture(servers) {
  let inspections = 0;
  const server = createServer((request, response) => {
    const [, id, action] = /^\/containers\/([^/]+)\/(json|stats|logs)(?:\?|$)/.exec(request.url) ?? [];
    if (request.method === "GET" && servers.has(id) && action === "json") {
      inspections += 1;
      response.end(JSON.stringify({
        Id: id, Name: `/${id}`, State: { Running: true, Status: "running" },
        Config: { Labels: { "serversentinel.managed": "true", "serversentinel.server-id": id }, OpenStdin: true, AttachStdin: true },
        HostConfig: { RestartPolicy: { Name: "no", MaximumRetryCount: 0 } },
        Mounts: [{ Source: servers.get(id), Destination: "/data/server" }]
      }));
    } else if (request.method === "GET" && servers.has(id) && action === "stats") {
      response.end("{}");
    } else if (request.method === "GET" && servers.has(id) && action === "logs") {
      response.end();
    } else if (request.url === "/_ping") {
      response.end("OK");
    } else if (request.url === "/info") {
      response.end(JSON.stringify({ LiveRestoreEnabled: true, MemTotal: 16 * 1024 ** 3 }));
    } else {
      response.writeHead(404).end('{"message":"No such container"}');
    }
  });
  return { server, inspections: () => inspections };
}

async function processMetrics(pid) {
  const [status, stats] = await Promise.all([readFile(`/proc/${pid}/status`, "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
  const fields = stats.slice(stats.lastIndexOf(")") + 2).split(" ");
  return { rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(status)[1]), cpuTicks: Number(fields[11]) + Number(fields[12]) };
}

async function runtimeTrial(trial, ticksPerSecond) {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-release-"));
  const socketPath = join(directory, "docker.sock");
  const mode = scenario === "fleet" ? "all-in-one" : scenario;
  let mockDocker;
  let firstServerId;
  let mockPanel;
  let child;
  try {
    if (scenario === "fleet") {
      const servers = await seedFleet(directory);
      firstServerId = servers.keys().next().value;
      mockDocker = dockerFixture(servers);
      await listen(mockDocker.server, socketPath);
    }
    const portReservation = createServer();
    const { port } = await listen(portReservation, 0, "127.0.0.1");
    await new Promise((resolve) => portReservation.close(resolve));
    if (mode === "node") {
      mockPanel = new WebSocketServer({ host: "127.0.0.1", port });
      mockPanel.on("connection", (socket) => socket.once("message", (raw) => {
        const hello = JSON.parse(raw.toString());
        assert.equal(hello.type, "hello");
        socket.send(JSON.stringify({ type: "welcome", accepted: true, nodeId: "benchmark-node",
          nodeSecret: "benchmark-fixture", protocolVersion: hello.protocolVersion, features: hello.features }));
      }));
      await once(mockPanel, "listening");
    }
    const started = performance.now();
    child = spawn(process.execPath, ["server/dist/index.js"], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH, NODE_ENV: "production", TZ: "UTC", PORT: String(port), SS_MODE: mode,
        SERVERSENTINEL_DATA_DIR: directory, SERVERSENTINEL_DOCKER_DATA_DIR: directory, DOCKER_SOCKET: socketPath,
        SS_PANEL_URL: `http://127.0.0.1:${port}`, SS_JOIN_TOKEN: "benchmark-fixture", SERVERSENTINEL_SETUP_TOKEN: "benchmark-fixture" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_096); });
    const output = createInterface({ input: child.stdout });
    const readiness = mode === "node" ? "Node registration accepted." : "serverSENTINEL web panel listening";
    let readyMs;
    for await (const [line] of on(output, "line", { signal: AbortSignal.timeout(10_000), close: ["close"] })) {
      if (!line.includes(readiness)) continue;
      readyMs = round(performance.now() - started);
      break;
    }
    assert.ok(readyMs, `Process exited before readiness: ${stderr}`);
    const initial = await processMetrics(child.pid);
    let idle;
    if (idleSeconds > 0) {
      // Exclude immediate startup polls. A 30s window covers six lifecycle polls.
      await delay(2_000);
      const before = await processMetrics(child.pid);
      const inspections = mockDocker?.inspections();
      const sampleStarted = performance.now();
      await delay(idleSeconds * 1_000);
      const after = await processMetrics(child.pid);
      const cpuMs = (after.cpuTicks - before.cpuTicks) / ticksPerSecond * 1_000;
      const dockerInspections = mockDocker ? mockDocker.inspections() - inspections : undefined;
      if (mockDocker && idleSeconds >= 5) assert.ok(dockerInspections >= fleetSize, "Fixture did not observe its running fleet");
      idle = { idleSeconds, idleCpuMs: round(cpuMs), idleCpuPercent: round(cpuMs * 100 / (performance.now() - sampleStarted)),
        idleRssMiB: round(after.rssKiB / 1024), dockerInspections };
    }
    const endpoints = firstServerId ? await checkFleetEndpoints(port, firstServerId) : undefined;
    report({ trial, readyMs, readyRssMiB: round(initial.rssKiB / 1024), ...idle, ...endpoints });
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const forceExit = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await exited;
      } finally {
        clearTimeout(forceExit);
      }
    }
    if (mockPanel) {
      for (const socket of mockPanel.clients) socket.terminate();
      await new Promise((resolve) => mockPanel.close(resolve));
    }
    if (mockDocker) await new Promise((resolve) => mockDocker.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

if (scenario === "size") {
  const [server, web, shared] = await Promise.all(["server", "web", "shared"].map((workspace) => treeBytes(join(repositoryRoot, workspace, "dist"))));
  report({ server, web, shared, totalBytes: server.bytes + web.bytes + shared.bytes });
} else if (scenario === "browser") {
  await browserTrials();
} else {
  const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  for (let trial = 1; trial <= repeats; trial++) await runtimeTrial(trial, ticksPerSecond);
}
