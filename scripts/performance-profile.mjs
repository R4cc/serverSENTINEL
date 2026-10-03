// Run after npm run build. Fixtures use temporary files and an in-memory database.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { request } from "playwright";
import { startDemoHarness, signInThroughApi } from "./lib/demo-harness.mjs";
import { timelineResourcePoints } from "../server/dist/serverTimeline.js";
import { localResolveExistingPath } from "../server/dist/files/fileService.js";
import { listServerDirectory } from "../server/dist/runtime/local/fileService.js";
import { measureWorldSize } from "../server/dist/servers/exportSelection.js";
import { openStorageDatabase } from "../server/dist/storage/database.js";
import { ResourceStatsRepository } from "../server/dist/storage/resourceStatsRepository.js";

async function measure(name, run, repeats = 7) {
  await run();
  const timings = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const start = performance.now();
    await run();
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ name, medianMs: Number(timings[Math.floor(repeats / 2)].toFixed(2)), repeats }));
}

const database = openStorageDatabase(":memory:");
try {
  const samples = Array.from({ length: 7 * 24 * 60 * 12 }, (_, index) => ({
    sampledAt: index * 5_000, readAt: new Date(index * 5_000).toISOString(),
    available: true, running: true, cpuPercent: 20 + index % 80, cpuCapacityCores: 4,
    memoryUsageBytes: 1024 ** 3 + index, memoryLimitBytes: 4 * 1024 ** 3,
    playersOnline: index % 50, playerPingMs: Array.from({ length: 50 }, (_, player) => 20 + player),
    networkRxBytes: index * 100, networkTxBytes: index * 200
  }));
  database.connection.exec(`
    INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at)
      VALUES ('local', 'Local', 'local', 'online', 1, '', '');
    INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, created_at, updated_at)
      VALUES ('profile', 'local', 'Profile', '/unused', '{}', '', '');
  `);
  database.transaction((connection) => {
    const insert = connection.prepare("INSERT INTO resource_stats VALUES (?, ?, ?)");
    for (const sample of samples) insert.run("profile", sample.sampledAt, JSON.stringify(sample));
  });
  const repository = new ResourceStatsRepository(database);
  const to = samples.at(-1).sampledAt;
  await measure("timeline: project 120960 samples to 900 points", () => {
    assert.ok(timelineResourcePoints(samples, 0, to, 900).length <= 900);
  });
  await measure("timeline: read 7 days of stored samples", () => {
    assert.equal(repository.listRange("profile", 0, to, true).length, samples.length);
  });
  await measure("timeline: read and project 7 days", () => {
    assert.ok(timelineResourcePoints(repository.listRange("profile", 0, to, true), 0, to, 900).length <= 900);
  });
} finally {
  database.close();
}

const directory = await mkdtemp(join(tmpdir(), "sentinel-performance-files-"));
try {
  await mkdir(join(directory, "world", "region"), { recursive: true });
  await writeFile(join(directory, "server.properties"), "level-name=world\n");
  for (let offset = 0; offset < 2_000; offset += 32) {
    await Promise.all(Array.from({ length: 32 }, (_, index) => {
      const fileIndex = offset + index;
      return fileIndex < 2_000 ? writeFile(join(directory, "world", "region", `r.${fileIndex}.mca`), "region") : undefined;
    }));
  }
  const server = { serverDir: directory };
  const runtime = {
    resolveExistingPath: localResolveExistingPath,
    listFiles: listServerDirectory,
    readFile: async (_server, target) => ({ content: await readFile(target, "utf8") })
  };
  await measure("files: list 2000 local region files", () => listServerDirectory(server, join(directory, "world", "region")));
  await measure("storage: measure world with 2000 local files", async () => {
    assert.equal(await measureWorldSize(runtime, server), 12_000);
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}

const demoStarted = performance.now();
const demo = await startDemoHarness({ dataDirectoryPrefix: "sentinel-performance-demo-" });
console.log(JSON.stringify({ name: "demo: startup to HTTP ready", durationMs: Number((performance.now() - demoStarted).toFixed(2)) }));
let context;
try {
  context = await request.newContext({ baseURL: demo.baseUrl, extraHTTPHeaders: { "X-Requested-With": "XMLHttpRequest" } });
  await signInThroughApi({ request: context }, demo.baseUrl);
  // Demo server/runtime data is simulated in the browser; these are real backend reads.
  for (const path of ["/api/auth/session", "/api/app", "/api/runtime/types"]) {
    await measure(`demo: GET ${path}`, async () => {
      const result = await context.get(path);
      assert.ok(result.ok(), await result.text());
      await result.body();
    });
  }
} finally {
  await context?.dispose();
  await demo.stop();
}
