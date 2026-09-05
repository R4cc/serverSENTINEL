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
    lib: { entry: resolve("scripts/fixtures/export-workspace.ts"), name: "AsyncWorkspaces", formats: ["iife"] }
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

  const empty = { latest: null, artifact: null };
  const running = { latest: { id: "export-A", status: "running", canCancel: true, createdAt: "2026-09-05" }, artifact: null };
  const select = async id => { await page.evaluate(id => window.selectServer(id), id); await settle(); };
  const a = await request("/api/servers/A/exports");
  await reply(a, running);
  assert.equal((await state()).locked, true);
  await select("B");
  const b = await request("/api/servers/B/exports");
  assert.deepEqual((await state()).data, empty);
  assert.equal((await state()).loading, true);
  assert.equal((await state()).locked, false);
  await reply(b, { error: { message: "B unavailable" } }, 503);
  assert.equal((await state()).error, "B unavailable");
  assert.equal((await state()).loading, false);
  assert.equal((await state()).locked, false);

  // Late reads, errors and finally blocks cannot cross visits, even back to the same server.
  await select("A");
  const oldA = await request("/api/servers/A/exports", "GET", a);
  await select("B");
  const oldB = await request("/api/servers/B/exports", "GET", b);
  await select("A");
  const newA = await request("/api/servers/A/exports", "GET", oldA);
  await reply(oldA, running);
  await reply(oldB, { error: { message: "old failure" } }, 503);
  assert.equal((await state()).loading, true);
  assert.equal((await state()).locked, false);
  assert.equal((await state()).error, "");
  await reply(newA, empty);

  // A late start must not install A's optimistic operation into B or supersede B's read.
  await page.evaluate(() => window.exports.openExport("A"));
  await settle();
  await page.evaluate(() => { void window.exports.runExport(); });
  const startA = await request("/api/exports", "POST");
  await select("B");
  const nextB = await request("/api/servers/B/exports", "GET", oldB);
  await reply(startA, running.latest);
  assert.equal((await state()).locked, false);
  assert.equal((await state()).busy, false);
  assert.equal((await state()).open, false);
  await reply(nextB, empty);
  assert.equal((await state()).loading, false);

  // Cancel and delete completions must not refresh the old server over the current one.
  await select("A");
  const cancelRead = await request("/api/servers/A/exports", "GET", newA);
  await reply(cancelRead, running);
  await page.evaluate(() => { void window.exports.cancelExport("export-A"); });
  const cancel = await request("/api/operations/export-A/cancel", "POST");
  const artifact = { operationId: "export-A", filename: "a.zip", createdAt: "2026-09-05" };
  await page.evaluate(artifact => { void window.exports.deleteExport(artifact); }, artifact);
  await page.evaluate(() => window.confirm(true));
  const deletion = await request("/api/exports/export-A", "DELETE");
  await select("B");
  const finalB = await request("/api/servers/B/exports", "GET", nextB);
  const count = await page.evaluate(() => window.pending.length);
  await reply(cancel, running.latest);
  await reply(deletion, { ok: true });
  assert.equal(await page.evaluate(() => window.pending.length), count, "Stale callbacks started a refresh");
  await reply(finalB, empty);
  assert.equal((await state()).loading, false);
  assert.equal((await state()).deleting, "");

  // A confirmation for an old server must not send a mutation after navigation.
  await page.evaluate(artifact => { void window.exports.deleteExport(artifact); }, artifact);
  await select("A");
  const beforeConfirm = await page.evaluate(() => window.pending.length);
  await page.evaluate(() => window.confirm(true));
  await settle();
  assert.equal(await page.evaluate(() => window.pending.length), beforeConfirm);

  const disabledRead = await request("/api/servers/A/exports", "GET", cancelRead);
  await page.evaluate(() => window.setEnabled(false));
  await settle();
  await reply(disabledRead, running);
  assert.deepEqual((await state()).data, empty);
  assert.equal((await state()).loading, false);
  assert.equal((await state()).locked, false);
  await page.evaluate(() => window.setEnabled(true));
  await settle();
  const enabledRead = await request("/api/servers/A/exports", "GET", disabledRead);
  await reply(enabledRead, running);
  assert.equal((await state()).locked, true);
  await page.evaluate(() => { void window.exports.refreshServerExportState(); });
  const failedRead = await request("/api/servers/A/exports", "GET", enabledRead);
  await reply(failedRead, { error: { message: "Status unavailable" } }, 503);
  assert.equal((await state()).locked, false);
  assert.equal((await state()).error, "Status unavailable");

  // Same-server reads remain latest-request-wins, including a background read
  // that overtakes a foreground request (it must also finish the loading state).
  await page.evaluate(() => {
    void window.exports.refreshServerExportState();
    void window.exports.refreshServerExportState("A", { background: true });
  });
  const older = await request("/api/servers/A/exports", "GET", failedRead);
  const newer = await request("/api/servers/A/exports", "GET", older);
  await reply(newer, empty);
  await reply(older, { error: { message: "Stale error" } }, 503);
  assert.equal((await state()).loading, false);
  assert.equal((await state()).error, "");

  // Starting on the current server still locks it immediately; pre-start reads
  // cannot erase the optimistic operation while the post-start refresh loads.
  await page.evaluate(() => { void window.exports.refreshServerExportState(); });
  const preStart = await request("/api/servers/A/exports", "GET", newer);
  await page.evaluate(() => window.exports.openExport("A"));
  await settle();
  await page.evaluate(() => { void window.exports.runExport(); });
  const currentStart = await request("/api/exports", "POST", startA);
  await reply(currentStart, running.latest);
  const postStart = await request("/api/servers/A/exports", "GET", preStart);
  assert.equal((await state()).locked, true);
  await reply(preStart, empty);
  assert.equal((await state()).locked, true);
  await reply(postStart, running);
  await page.evaluate(() => { void window.exports.refreshServerExportState(); });
  const unmountedRead = await request("/api/servers/A/exports", "GET", postStart);
  await page.evaluate(() => window.unmount());
  await reply(unmountedRead, running);
  assert.deepEqual(errors, []);
  console.log("Export workspace browser regression checks passed.");
} finally {
  await browser.close();
}
