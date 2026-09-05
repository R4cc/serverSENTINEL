import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "vite";
import { chromium } from "playwright";
import { launchBrowser } from "./lib/demo-harness.mjs";

// Bundle an isolated React harness so races exercise the real hooks without changing demo data.
const bundle = await build({
  configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false, minify: false,
    lib: { entry: resolve("scripts/fixtures/async-workspaces.ts"), name: "AsyncWorkspaces", formats: ["iife"] }
  }
});
const code = bundle[0].output.find((entry) => entry.type === "chunk" && entry.isEntry).code;
const browser = await launchBrowser(chromium);
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://async.test/**", (route) => route.fulfill({
    contentType: "text/html", body: '<div id="root"></div>'
  }));
  await page.goto("http://async.test/");
  await page.addScriptTag({ content: code });
  assert.deepEqual(errors, []);
  const state = () => page.locator("#state").textContent().then(JSON.parse);
  const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const reply = async (index, body, status = 200) => {
    await page.evaluate(({ index, body, status }) => window.reply(index, body, status), { index, body, status });
    await settle();
  };
  const request = async (path, method = "GET", after = -1) => {
    await page.waitForFunction(({ path, method, after }) => window.pending.some((item, index) => index > after && item.path === path && item.method === method), { path, method, after });
    return page.evaluate(({ path, method, after }) => window.pending.findIndex((item, index) => index > after && item.path === path && item.method === method), { path, method, after });
  };
  const mod = { filename: "shared.jar", displayName: "Shared", enabled: true, size: 1, modifiedAt: "2026-01-01" };
  const a = await request("/api/servers/A/mods");
  await reply(a, { mods: [mod] });
  await page.evaluate(() => window.mods.actions.setInstalledModEnabled(window.mods.data.installedMods[0], false));
  const toggleA = await request("/api/servers/A/mods", "PATCH");
  await page.evaluate(() => window.selectServer("B"));
  const b = await request("/api/servers/B/mods");
  await reply(b, { mods: [mod] });
  await reply(toggleA, { filename: "shared.jar.disabled", enabled: false });
  assert.equal((await state()).mods[0].enabled, true, "A toggle changed B");
  assert.equal((await state()).mods[0].filename, "shared.jar");

  // An older request for A must remain stale after A -> B -> A.
  await page.evaluate(() => { void window.mods.actions.retry(); });
  const oldB = await request("/api/servers/B/mods", "GET", b);
  await page.evaluate(() => window.selectServer("A"));
  const nextA = await request("/api/servers/A/mods", "GET", toggleA);
  await reply(nextA, { mods: [mod] });
  await page.evaluate(() => window.selectServer("B"));
  const nextB = await request("/api/servers/B/mods", "GET", oldB);
  await reply(oldB, { mods: [{ ...mod, enabled: false }] });
  assert.equal((await state()).loading, true, "Old load cleared newer loading state");
  await reply(nextB, { mods: [mod] });
  assert.equal((await state()).mods[0].enabled, true);

  // Same-server reads are latest-request-wins, including errors and finally blocks.
  await page.evaluate(() => { void window.mods.actions.retry(); void window.mods.actions.retry(); });
  const first = await request("/api/servers/B/mods", "GET", nextB);
  const second = await request("/api/servers/B/mods", "GET", first);
  await reply(second, { mods: [mod] });
  await reply(first, { mods: [{ ...mod, enabled: false }] });
  assert.equal((await state()).mods[0].enabled, true);

  await page.evaluate(() => window.mods.actions.setInstalledModEnabled(window.mods.data.installedMods[0], false));
  const failedToggle = await request("/api/servers/B/mods", "PATCH");
  await page.evaluate(() => window.selectServer("A"));
  const finalA = await request("/api/servers/A/mods", "GET", nextA);
  await reply(finalA, { mods: [mod] });
  await page.evaluate(() => window.mods.actions.setInstalledModEnabled(window.mods.data.installedMods[0], false));
  const currentToggle = await request("/api/servers/A/mods", "PATCH", toggleA);
  await reply(failedToggle, { error: { message: "Delayed failure" } }, 500);
  assert.equal((await state()).mods[0].enabled, false, "Old error rolled back a different server");
  // The stale queue must not delete the new queue: the second intent must still be sent.
  await page.evaluate(() => window.mods.actions.setInstalledModEnabled(window.mods.data.installedMods[0], true));
  await reply(currentToggle, { filename: "shared.jar.disabled", enabled: false });
  const queuedToggle = await request("/api/servers/A/mods", "PATCH", currentToggle);
  await reply(queuedToggle, { filename: "shared.jar", enabled: true });
  assert.equal((await state()).mods[0].enabled, true);

  await page.evaluate(() => { void window.nodes.onViewDetails({ id: "A", name: "A" }); });
  const nodeA = await request("/api/nodes/A");
  await page.evaluate(() => { void window.nodes.onViewDetails({ id: "B", name: "B" }); });
  const nodeB = await request("/api/nodes/B");
  await reply(nodeA, { id: "A", name: "late A" });
  assert.equal((await state()).selectedNode.id, "B");
  assert.equal((await state()).busyNodeId, "B", "Old finally cleared newer pending action");
  await page.evaluate(() => window.nodes.onCloseDetails());
  await reply(nodeB, { id: "B", name: "late B" });
  assert.equal((await state()).selectedNode, null, "Late details reopened drawer");
  assert.equal((await state()).busy, false);

  await page.evaluate(() => { void window.nodes.onViewDetails({ id: "A", name: "A" }); });
  const older = await request("/api/nodes/A", "GET", nodeA);
  await page.evaluate(() => { void window.nodes.onViewDetails({ id: "A", name: "new A" }); });
  const newer = await request("/api/nodes/A", "GET", older);
  await reply(newer, { id: "A", name: "new response" });
  await reply(older, { id: "A", name: "old response" });
  assert.equal((await state()).selectedNode.name, "new response");

  await page.evaluate(() => { void window.nodes.onShowInstall({ id: "A", name: "A" }); });
  await page.waitForFunction(() => window.pending.some((item) => item.path.includes("/install?")));
  const install = await page.evaluate(() => window.pending.findIndex((item) => item.path.includes("/install?")));
  await page.evaluate(() => window.nodes.onClearInstall());
  await reply(install, { node: { id: "A", name: "A" } });
  assert.equal((await state()).install, null, "Late install instructions reopened dialog");

  await page.evaluate(() => { void window.nodes.onUpdateNode({ id: "A", name: "A" }); });
  const update = await request("/api/nodes/A/update", "POST");
  await page.evaluate(() => window.nodes.onCloseDetails());
  await reply(update, { mode: "manual", message: "Manual recovery required" });
  assert.equal((await state()).selectedNode, null, "Manual recovery reopened a closed drawer");
  assert.deepEqual(errors, []);
  console.log("Async workspace smoke passed: cross-server toggles, return visits, request ordering, pending ownership, closed/replaced drawers.");
} finally {
  await browser.close();
}
