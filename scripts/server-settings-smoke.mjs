import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "vite";
import { chromium } from "playwright";
import { launchBrowser } from "./lib/demo-harness.mjs";

// Real React lifecycle, with delayed version responses to exercise runtime-switch races.
const bundle = await build({
  configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { write: false, minify: false, lib: { entry: resolve("scripts/fixtures/server-settings.ts"), name: "ServerSettings", formats: ["iife"] } }
});
const browser = await launchBrowser(chromium);
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://settings.test/**", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://settings.test/");
  await page.addScriptTag({ content: bundle[0].output.find(entry => entry.type === "chunk" && entry.isEntry).code });
  const state = () => page.locator("#state").textContent().then(JSON.parse);
  const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const requests = async path => {
    await page.waitForFunction(path => window.pending.some(request => request.path === path), path);
    return page.evaluate(path => window.pending.flatMap((request, index) => request.path === path ? [index] : []), path);
  };
  const reply = async (index, body, status = 200) => { await page.evaluate(({ index, body, status }) => window.reply(index, body, status), { index, body, status }); await settle(); };
  const fabricMinecraft = (await requests("/api/runtime/fabric/minecraft-versions"))[0];
  const fabricBuilds = await requests("/api/runtime/fabric/versions?minecraftVersion=1.21.4");
  assert.equal((await state()).versions.loading, true);

  await page.evaluate(() => window.create.updateMinimumHeap(20));
  await settle();
  assert.equal((await state()).create.minimumHeapGb, 8);
  await page.evaluate(() => window.create.updateMaximumHeap(1));
  await settle();
  assert.equal((await state()).create.javaArgs, "-Xms8G -Xmx8G");
  await page.evaluate(() => window.edit.updateJavaArgs("-Xms3G -Xmx6G -XX:+UseG1GC"));
  await settle();
  assert.equal((await state()).edit.minimumHeapGb, 3);
  assert.equal((await state()).edit.maximumHeapGb, 6);
  await page.evaluate(() => window.edit.updateMaximumHeap(5));
  await settle();
  assert.equal((await state()).edit.javaArgs, "-Xms3G -Xmx5G -XX:+UseG1GC");
  await page.evaluate(() => window.setMax(2));
  await settle();
  assert.equal((await state()).create.javaArgs, "-Xms2G -Xmx2G");
  await page.evaluate(() => window.edit.resetMemory(1, 2, "-XX:+UseG1GC"));
  await settle();
  assert.equal((await state()).edit.javaArgs, "-Xms1G -Xmx2G -XX:+UseG1GC");

  await page.evaluate(() => window.setRuntime("paper"));
  const paperMinecraft = (await requests("/api/runtime/paper/minecraft-versions"))[0];
  const paperBuilds = await requests("/api/runtime/paper/versions?minecraftVersion=1.21.4");
  await reply(paperMinecraft, { versions: [{ id: "1.21.4", type: "release", supported: true }] });
  for (const index of paperBuilds) await reply(index, { runtimeVersions: [{ runtimeVersion: "132", stable: true }] });
  // A late response for the former runtime must not replace the selected runtime's catalogue.
  await reply(fabricMinecraft, { versions: [{ id: "obsolete", type: "release" }] });
  for (const index of fabricBuilds) await reply(index, { runtimeVersions: [{ runtimeVersion: "obsolete" }] });
  assert.equal((await state()).versions.versions[0].version, "1.21.4");
  assert.equal((await state()).builds.versions[0].runtimeVersion, "132");
  assert.equal((await state()).builds.loading, false);

  await page.evaluate(() => { window.setRuntime("fabric"); window.setMinecraft("1.20.1"); });
  for (const index of await requests("/api/runtime/fabric/versions?minecraftVersion=1.20.1")) await reply(index, {}, 503);
  assert.deepEqual((await state()).builds.versions, []);
  assert((await state()).editBuilds.versions.length > 0, "Edit retains its offline Fabric fallback");
  assert.equal((await state()).builds.loading, false);
  assert.deepEqual(errors, []);
  console.log("server settings smoke passed: heap limits, Java flags, resets, stale version responses and offline fallbacks");
} finally { await browser.close(); }
