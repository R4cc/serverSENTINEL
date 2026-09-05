import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "vite";
import { chromium } from "playwright";
import { launchBrowser, startDemoHarness, repositoryRoot } from "./lib/demo-harness.mjs";

// Exercise the shared component inside the real Sonner host, with deterministic reports.
const root = resolve(repositoryRoot, "web").replaceAll("\\", "/");
const bundle = await build({
  configFile: false, root, logLevel: "error",
  plugins: [{ name: "toast-fixture", resolveId: id => id === "virtual:toast-fixture" ? id : undefined,
    load: id => id === "virtual:toast-fixture" ? `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {toast} from 'sonner';
      import {ToastProgress} from '${root}/src/components/ToastProgress.tsx';
      import {AppToaster} from '${root}/src/components/AppToaster.tsx';
      import '${root}/src/styles.css';
      createRoot(document.getElementById('root')).render(React.createElement(AppToaster, {darkMode: false}));
      window.report = (progress, status = 'running', id = 'job') => {
        const options = {id, duration: Infinity, description: React.createElement(ToastProgress, {key: id, progress, status}, 'example-mod.jar — Downloading')};
        toast[status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : 'loading']('Updating mod', options);
      };
    ` : undefined }],
  build: { write: false, rollupOptions: { input: "virtual:toast-fixture" } }
});
const output = bundle.output;
const js = output.find(item => item.type === "chunk" && item.isEntry).code;
const css = output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => item.source).join("\n");
const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-toast-smoke-" });
let browser;
try {
  browser = await launchBrowser(chromium);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/toast-fixture", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script type="module" src="/toast-fixture.js"></script>' }));
  await page.route("**/toast-fixture.js", route => route.fulfill({ contentType: "text/javascript", body: js }));
  await page.goto(`${harness.baseUrl}/toast-fixture`);
  await page.addStyleTag({ content: css });
  await page.waitForFunction(() => typeof window.report === "function");
  await page.evaluate(() => window.report(10));
  const bar = page.getByRole("progressbar");
  await bar.waitFor();
  const amount = () => bar.locator("span").evaluate(el => Number(getComputedStyle(el).transform.split("(")[1].split(",")[0]) * 100);
  await page.waitForTimeout(1000);
  const first = await amount();
  await page.waitForTimeout(600);
  assert(await amount() > first, "progress should move between server reports");
  await page.evaluate(() => window.report(80));
  await page.waitForTimeout(150);
  assert(await amount() < 80, "a large report should ease in rather than jump");
  await page.waitForTimeout(1800);
  const advanced = await amount();
  assert(advanced > 75);
  await page.evaluate(() => window.report(5));
  await page.waitForTimeout(400);
  assert(await amount() >= advanced, "a new stage must not move backward");
  await page.evaluate(() => window.report(100));
  await page.waitForTimeout(1800);
  assert(await amount() < 100, "running jobs must not appear complete");
  await page.evaluate(() => window.report(100, "succeeded"));
  await page.waitForTimeout(500);
  assert(Math.abs(await amount() - 100) < 0.01);
  const box = await bar.boundingBox();
  assert(box.width > 100 && box.x >= 0 && box.x + box.width <= 390, "bar should fit a phone toast");
  await page.evaluate(() => window.report(0));
  await page.waitForTimeout(400);
  assert(await amount() < 10, "a reused toast should start a fresh operation");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.report(30));
  await page.waitForTimeout(200);
  assert(Math.abs(await amount() - 30) < 0.01, "reduced motion should show measured progress immediately");
  await page.waitForTimeout(300);
  assert(Math.abs(await amount() - 30) < 0.01, "reduced motion should not creep");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => window.report(undefined, "running", "unknown"));
  const unknown = page.locator('.toastProgress:not([aria-valuenow])');
  await unknown.waitFor();
  assert.equal(await unknown.getAttribute("aria-valuenow"), null);
  await page.evaluate(() => window.report(undefined, "failed", "unknown"));
  await page.waitForTimeout(400);
  const stopped = await unknown.locator("span").getAttribute("style");
  await page.waitForTimeout(400);
  assert.equal(await unknown.locator("span").getAttribute("style"), stopped, "failure must stop progress");
  assert.deepEqual(errors, []);
  console.log("Toast progress smoke passed: easing, stage resets, completion, failure, unknown progress, reduced motion, and phone layout.");
} finally {
  await browser?.close();
  await harness.stop();
}
