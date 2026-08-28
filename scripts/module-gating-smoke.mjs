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

/**
 * Each module, by the navigation entry it owns, the chunk that must not be fetched without it, and
 * an endpoint that must refuse while it is off. Adding a module here is how a new one gets covered.
 */
const modules = [
  {
    id: "schedules",
    label: "Schedules",
    navigationTitle: "Open schedules",
    switchLabel: "Schedules module",
    chunk: /SchedulesModule-.*\.js$/,
    endpoint: "/api/servers/11111111-1111-4111-8111-111111111111/schedules"
  },
  {
    id: "managedContent",
    label: "Managed content",
    navigationTitle: "Open mods",
    switchLabel: "Managed content module",
    chunk: /ModsModule-.*\.js$/,
    endpoint: "/api/servers/11111111-1111-4111-8111-111111111111/mods"
  },
  {
    id: "playerInsights",
    label: "Player insights",
    navigationTitle: "Open players",
    switchLabel: "Player insights module",
    chunk: /PlayersModule-.*\.js$/,
    endpoint: "/api/players/insights"
  }
];

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

async function withPanel(run, options = {}) {
  const harness = await startDemoHarness({ dataDirectory, ...options });
  const browser = await launchBrowser(chromium);
  try {
    return await run(harness, browser);
  } finally {
    await browser.close();
    await harness.stop();
  }
}

function storeLegacyAdminPermissions() {
  const database = new Database(join(dataDirectory, "serversentinel.sqlite"));
  try {
    const row = database.prepare("SELECT permissions_json FROM users WHERE username = 'demo'").get();
    assert(row, "the demo account was not stored before the legacy-permission check");
    const permissions = JSON.parse(row.permissions_json).filter((permission) => !permission.startsWith("players."));
    database.prepare("UPDATE users SET role_preset = 'admin', permissions_json = ? WHERE username = 'demo'")
      .run(JSON.stringify(permissions));
  } finally {
    database.close();
  }
}

function disableModulesInStorage(moduleIds) {
  const database = new Database(join(dataDirectory, "serversentinel.sqlite"));
  try {
    database.prepare(`
      INSERT INTO storage_metadata (key, value) VALUES ('modules.disabled', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(moduleIds));
  } finally {
    database.close();
  }
}

try {
  await withPanel(async ({ baseUrl }, browser) => {
    const { page, scripts } = await openSession(browser);
    await signInThroughForm(page, baseUrl);
    // The mods workspace only exists for a runtime that has content to manage, and the demo fleet
    // supplies one, so opening a server first is what puts both entries in the navigation.
    await page.locator('.sideNav button[title="Open overview"]').click();
    await page.locator(".workspacePage-overview").waitFor();
    await settlePrefetch(page);

    await openSettingsCategory(page, "modules");
    for (const module of modules) {
      const card = page.getByRole("switch", { name: module.switchLabel, exact: true });
      assert(await card.isVisible(), `${module.label}: the Modules settings category does not offer its card`);
      assert(await card.isChecked(), `${module.label}: the card does not reflect the installation state`);
    }

    for (const module of modules) {
      assert(await page.locator(`.sideNav button[title="${module.navigationTitle}"]`).isVisible(), `${module.label}: an enabled module is missing from the navigation`);
      assert(scripts.some((url) => module.chunk.test(url)), `${module.label}: an enabled module's chunk was never fetched, so this run could not prove the disabled case`);
    }

    // A module that also feeds a core page has to outlive its own page. Managed content backs the
    // overview's content-health card, so leaving for a non-server page and returning must not throw
    // its loaded list away — the list is expected to be there before anything could re-fetch it.
    await page.locator('.sideNav button[title="Open mods"]').click();
    await page.locator(".modsWorkspaceIdentity").first().waitFor();
    await page.locator('.sideNav button[title="Open settings"]').click();
    await page.locator(".workspacePage-settings").waitFor();
    await page.locator('.sideNav button[title="Open mods"]').click();
    assert(
      await page.locator(".modsWorkspaceIdentity").first().isVisible(),
      "returning to the managed content page rebuilt its list, so the module did not survive leaving the server workspace"
    );
  });

  // Player Insights added permissions to every preset after installations already had accounts.
  // Reopen the seeded account outside demo mode with the old Admin grant and prove the stored
  // preset is upgraded before module access reaches the rendered navigation.
  storeLegacyAdminPermissions();
  await withPanel(async ({ baseUrl }, browser) => {
    const { page } = await openSession(browser);
    await signInThroughForm(page, baseUrl);
    const playerHeadsOnboarding = page.getByRole("dialog", { name: "Player heads on Overview" });
    await playerHeadsOnboarding.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    if (await playerHeadsOnboarding.isVisible()) {
      await playerHeadsOnboarding.getByRole("button", { name: "Keep disabled", exact: true }).click();
      await playerHeadsOnboarding.waitFor({ state: "hidden" });
    }
    await openSettingsCategory(page, "modules");

    const playerInsights = page.getByRole("switch", { name: "Player insights module", exact: true });
    assert(await playerInsights.isChecked(), "the legacy Admin check did not keep Player Insights enabled");
    assert(
      await page.locator('.sideNav button[data-nav-page="players"]').isVisible(),
      "an enabled Player Insights module is missing from the navigation for a legacy Admin account"
    );
  }, { env: { SERVERSENTINEL_ENABLE_DEMO: "false" } });

  disableModulesInStorage(modules.map((module) => module.id));

  await withPanel(async ({ baseUrl }, browser) => {
    const { page, scripts } = await openSession(browser);
    await signInThroughForm(page, baseUrl);
    await page.locator('.sideNav button[title="Open overview"]').click();
    await page.locator(".workspacePage-overview").waitFor();
    await settlePrefetch(page);

    for (const module of modules) {
      assert(!await page.locator(`.sideNav button[title="${module.navigationTitle}"]`).isVisible(), `${module.label}: a disabled module is still offered in the navigation`);
      const fetched = scripts.filter((url) => module.chunk.test(url));
      assert(fetched.length === 0, `${module.label}: a disabled module's code was still downloaded: ${fetched.join(", ")}`);

      // The panel is the authority, so its endpoints must refuse regardless of what the browser did.
      const refused = await page.request.get(`${baseUrl}${module.endpoint}`, { headers: { "X-Requested-With": "XMLHttpRequest" } });
      assert.equal(refused.status(), 403, `${module.label}: a disabled module's endpoint answered instead of refusing`);
    }

    await openSettingsCategory(page, "modules");
    for (const module of modules) {
      const card = page.getByRole("switch", { name: module.switchLabel, exact: true });
      assert(await card.isVisible(), `${module.label}: a disabled module disappeared from settings, leaving no way to switch it back on`);
      assert(!await card.isChecked(), `${module.label}: the card does not reflect the disabled installation state`);
    }
  });

  console.log(`Module gating smoke passed for ${modules.length} modules: navigation, chunk loading, panel authorization, and the settings cards all follow the installation state.`);
} finally {
  await rm(dataDirectory, { recursive: true, force: true });
}
