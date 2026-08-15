import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { launchBrowser, signInThroughForm, startDemoHarness } from "./lib/demo-harness.mjs";

/**
 * Proves the part of the module system that unit tests cannot see: that a module switched off for
 * the installation leaves no trace in the browser — no navigation entry, no workspace, and above
 * all no request for its JavaScript. The chunk is what the module architecture promises to
 * withhold, and only a real page load can show whether it was fetched.
 *
 * The panel is started twice against one data directory because the demo account cannot write
 * settings by design: the module is switched off directly in the panel's own storage between runs,
 * exactly as an operator's toggle would have left it.
 */
const dataDirectory = await mkdtemp(join(tmpdir(), "serversentinel-module-smoke-"));
const moduleChunkPattern = /SchedulesModule-.*\.js$/;

/** Every script URL this page asked the panel for, so an absent chunk can be asserted. */
function trackScriptRequests(page) {
  const requested = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") requested.push(request.url());
  });
  return requested;
}

async function openSession(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const scripts = trackScriptRequests(page);
  return { context, page, scripts };
}

/** Chunks arrive on an idle prefetch, so give the queue a moment before judging it. */
async function settlePrefetch(page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1_500);
}

async function openSettingsCategory(page, category) {
  await page.locator('.sideNav button[title="Open settings"]').click();
  await page.locator(".workspacePage-settings").waitFor();
  await page.locator(`#settings-tab-${category}`).click();
}

async function withPanel(run) {
  const harness = await startDemoHarness({ dataDirectory });
  const browser = await launchBrowser(chromium);
  try {
    return await run(harness, browser);
  } finally {
    await browser.close();
    await harness.stop();
  }
}

function disableModuleInStorage(moduleId) {
  const database = new Database(join(dataDirectory, "serversentinel.sqlite"));
  try {
    database.prepare(`
      INSERT INTO storage_metadata (key, value) VALUES ('modules.disabled', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify([moduleId]));
  } finally {
    database.close();
  }
}

try {
  await withPanel(async ({ baseUrl }, browser) => {
    const { page, scripts } = await openSession(browser);
    await signInThroughForm(page, baseUrl);
    await settlePrefetch(page);

    assert(await page.locator('.sideNav button[title="Open schedules"]').isVisible(), "an enabled module is missing from the navigation");
    assert(scripts.some((url) => moduleChunkPattern.test(url)), "an enabled module's chunk was never fetched, so this run could not prove the disabled case");

    await page.locator('.sideNav button[title="Open schedules"]').click();
    await page.locator(".workspacePage-schedule").waitFor();

    await openSettingsCategory(page, "modules");
    const toggle = page.getByLabel("Enable the Schedules module");
    assert(await toggle.isVisible(), "the Modules settings category does not offer the module switch");
    assert(await toggle.isChecked(), "the module switch does not reflect the installation state");
  });

  disableModuleInStorage("schedules");

  await withPanel(async ({ baseUrl }, browser) => {
    const { page, scripts } = await openSession(browser);
    await signInThroughForm(page, baseUrl);
    await settlePrefetch(page);

    assert(!await page.locator('.sideNav button[title="Open schedules"]').isVisible(), "a disabled module is still offered in the navigation");
    const fetched = scripts.filter((url) => moduleChunkPattern.test(url));
    assert(fetched.length === 0, `a disabled module's code was still downloaded: ${fetched.join(", ")}`);

    // The panel is the authority, so its endpoints must refuse regardless of what the browser did.
    const refused = await page.request.get(`${baseUrl}/api/servers/11111111-1111-4111-8111-111111111111/schedules`, {
      headers: { "X-Requested-With": "XMLHttpRequest" }
    });
    assert.equal(refused.status(), 403, "a disabled module's endpoint answered instead of refusing");

    await openSettingsCategory(page, "modules");
    const toggle = page.getByLabel("Enable the Schedules module");
    assert(await toggle.isVisible(), "a disabled module disappeared from settings, leaving no way to switch it back on");
    assert(!await toggle.isChecked(), "the module switch does not reflect the disabled installation state");
  });

  console.log("Module gating smoke passed: navigation, chunk loading, panel authorization, and the settings switch all follow the installation state.");
} finally {
  await rm(dataDirectory, { recursive: true, force: true });
}
