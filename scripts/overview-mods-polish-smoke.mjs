import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-overview-mods-" });

async function openPage(page, name) {
  const nav = page.locator(`[data-nav-page="${name}"]`);
  await nav.waitFor({ state: "attached" });
  if (!await nav.isVisible()) await page.getByRole("button", { name: "Expand navigation" }).click();
  await nav.click();
  await page.locator(`.workspacePage-${name}`).waitFor();
}

async function assertFocused(locator, message) {
  await locator.page().waitForFunction(() => document.activeElement !== document.body);
  assert(await locator.evaluate(element => element === document.activeElement), message);
}

async function assertNoOverflow(page, selector) {
  assert.equal(await page.locator(selector).evaluate(element => element.scrollWidth > element.clientWidth + 1), false, `${selector} overflows`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "Document overflows");
}

async function capture(page, name) {
  const directory = process.env.UI_POLISH_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: !name.startsWith("review-") });
}

async function assertRequestRecovery(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await signInThroughApi(context, harness.baseUrl);
  const headers = { "X-Requested-With": "XMLHttpRequest" };
  const session = await (await context.request.get(`${harness.baseUrl}/api/auth/session`, { headers })).json();
  const base = await (await context.request.get(`${harness.baseUrl}/api/app`, { headers })).json();
  const now = new Date().toISOString();
  const server = { id: "polish-server", displayName: "Polish fixture", nodeId: "local", nodeName: "Panel Host", directoryLabel: "/test/polish", storageName: "polish", schedules: [], runtimeProfile: { minecraftVersion: "1.21.4", runtimeType: "fabric", javaMajorVersion: 21 }, dockerContainer: "polish", dockerImage: "test", hasDockerContainer: true, javaArgs: "-Xmx2G", createdAt: now, updatedAt: now };
  const nodes = [{ id: "local", name: "Panel Host", type: "local", status: "online", isInternal: true, dockerStatus: "available", dataPathStatus: "ready" }];
  const mod = { filename: "polished-library.jar", displayName: "Polished Library", enabled: true, size: 1, modifiedAt: now, compatibility: { status: "compatible", compatible: true, reason: "Compatible", serverSide: "required" }, modrinth: { projectId: "polished-library", versionId: "v1", filename: "polished-library.jar", versionNumber: "1.0.0", gameVersions: ["1.21.4"], loaders: ["fabric"], installedAt: now, installedWithForceIncompatible: false } };
  const plan = { serverId: server.id, generatedAt: now, counts: { totalInstalled: 1, safeUpdates: 0, reviewUpdates: 0, blockedUpdates: 0, unknown: 1, upToDate: 0 }, updates: [] };
  let checked = false, failing = false, cold = false, installedDelay = 0;
  const snapshotRequests = [];
  const page = await context.newPage();
  await page.addInitScript(() => {
    // Drive a saved-snapshot polling tick without making this regression wait a full minute.
    const minutePolls = new Map();
    const setInterval = window.setInterval.bind(window);
    const clearInterval = window.clearInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      const timer = setInterval(callback, delay, ...args);
      if (delay === 60_000 && typeof callback === "function") minutePolls.set(timer, () => callback(...args));
      return timer;
    };
    window.clearInterval = (timer) => { minutePolls.delete(timer); clearInterval(timer); };
    window.pollSavedModSnapshots = () => { for (const poll of minutePolls.values()) poll(); };
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/auth/session") return json({ ...session, demo: false });
    if (path === "/api/app") return json({ ...base, servers: [server], nodes, currentUser: session.user, dockerSocketMounted: true, modrinthApiConfigured: true });
    if (path === "/api/nodes") return json({ nodes });
    if (path.endsWith("/status")) return json({ server, docker: { configured: true, available: true, controllable: true, running: false, state: "exited" }, lifecycle: { state: "stopped", intent: "stopped" }, fileLogsAvailable: true });
    if (path.endsWith("/mods/update-plan/progress")) return json({ active: false, checked: 1, total: 1 });
    if (path.endsWith("/mods/update-plan")) {
      snapshotRequests.push({ kind: "plan", forced: url.searchParams.get("forceRefresh") === "true" });
      if (failing) return json({ error: { message: "Modrinth request failed: 503 temporarily unavailable." } }, 503);
      if (url.searchParams.get("forceRefresh") === "true") { checked = true; cold = false; }
      return json(checked ? plan : null);
    }
    if (path.endsWith("/mods")) {
      if (route.request().method() === "PATCH") {
        mod.enabled = route.request().postDataJSON().enabled;
        mod.filename = `polished-library.jar${mod.enabled ? "" : ".disabled"}`;
        return json({ filename: mod.filename, enabled: mod.enabled });
      }
      snapshotRequests.push({ kind: "installed", forced: url.searchParams.get("forceRefresh") === "true" });
      await new Promise(resolve => setTimeout(resolve, installedDelay));
      if (failing) return json({ error: { message: "Modrinth request failed: 503 temporarily unavailable." } }, 503);
      return json({ mods: cold ? [] : [mod], scannedAt: cold ? null : now });
    }
    if (path.endsWith("/events")) return json({ events: [], activity: {} });
    if (path.endsWith("/storage")) return json({ worldSizeBytes: 1, totalBytes: 100, availableBytes: 80 });
    if (path.endsWith("/files")) return json({ path: "/mods", entries: [] });
    if (path.endsWith("/timeline")) return json({ from: Number(url.searchParams.get("from")), to: Number(url.searchParams.get("to")), generatedAt: now, samples: [], events: [], schedules: [], scheduleAnnotationsAvailable: true, truncated: { schedules: false } });
    return route.continue();
  });
  try {
    await page.goto(harness.baseUrl);
    await page.locator(".appShell").waitFor();
    await openPage(page, "overview");
    const overviewUpdates = page.locator(".modUpdatesCard");
    await overviewUpdates.getByText("No updates found", { exact: true }).waitFor();
    await openPage(page, "mods");
    await page.locator(".modsWorkspaceIdentity strong").waitFor();
    assert.deepEqual(snapshotRequests, [{ kind: "installed", forced: false }, { kind: "plan", forced: false }], "Overview did not preload both saved snapshots, or opening Mods restarted a scan");
    await openPage(page, "settings");
    await openPage(page, "mods");
    assert.equal(await page.locator(".modsWorkspaceIdentity strong").innerText(), "Polished Library", "Revisiting Mods discarded its loaded list");
    assert.equal(snapshotRequests.length, 2, "Revisiting Mods refetched its snapshots");
    mod.displayName = "Background Updated Library";
    await page.evaluate(() => window.pollSavedModSnapshots());
    await page.getByText("Background Updated Library", { exact: true }).waitFor();
    assert.deepEqual(snapshotRequests.slice(2), [{ kind: "installed", forced: false }, { kind: "plan", forced: false }], "Periodic synchronization did not read both saved snapshots without an upstream scan");
    mod.displayName = "Polished Library";
    installedDelay = 500;
    await page.evaluate(() => window.pollSavedModSnapshots());
    await openPage(page, "overview");
    const manualList = page.waitForResponse(response => response.url().endsWith("/mods") && response.request().method() === "GET");
    const checkedPlan = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/mods/update-plan") && new URL(response.url()).searchParams.get("forceRefresh") === "true");
    await page.getByRole("button", { name: "Recheck mods for updates", exact: true }).click();
    await checkedPlan;
    await overviewUpdates.getByText("No updates found", { exact: true }).waitFor();
    await manualList;
    installedDelay = 0;
    assert.equal(snapshotRequests.filter(request => request.forced && request.kind === "plan").length, 1, "A manual update check did not request exactly one upstream scan");
    assert.equal(snapshotRequests.filter(request => request.forced && request.kind === "installed").length, 0, "The installed-list reload triggered a second upstream scan");
    assert.equal(await page.getByText("Everything is up to date", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Some versions could not be checked", { exact: true }).count(), 0, "Overview still shows unchecked-version details");
    assert.equal(await overviewUpdates.getByText("Open Mods to review unchecked versions.", { exact: true }).count(), 0);
    await openPage(page, "mods");
    const identity = page.locator(".modsWorkspaceIdentity strong");
    await page.waitForFunction(() => document.querySelector(".modsWorkspaceIdentity strong")?.textContent === "Polished Library");
    installedDelay = 1000;
    const patched = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith("/mods"));
    await page.locator(".modsWorkspaceSwitch").click();
    await patched;
    await page.waitForTimeout(100);
    assert.equal(await identity.innerText(), "Polished Library", "Toggle response replaced the display name with a filename");
    assert.equal(snapshotRequests.filter(request => request.forced).length, 1, "A mutation triggered another browser update scan");
    installedDelay = 0;
    await page.locator(".modsWorkspaceSwitch").click();
    await page.waitForFunction(() => document.querySelector('.modsWorkspaceSwitch input')?.checked);
    failing = true;
    await page.getByRole("button", { name: "Check updates", exact: true }).click();
    await page.getByText("Could not check updates", { exact: true }).waitFor();
    await page.getByText("Could not load installed mods", { exact: true }).waitFor();
    assert.equal(await identity.innerText(), "Polished Library", "Failed refresh discarded the installed list");
    failing = false;
    const updateError = page.locator(".inlineState").filter({ has: page.getByText("Could not check updates", { exact: true }) });
    await updateError.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByText("Could not check updates", { exact: true }).waitFor({ state: "hidden" });
    await page.getByText("Could not load installed mods", { exact: true }).waitFor({ state: "hidden" });

    cold = true;
    checked = false;
    const coldStart = snapshotRequests.length;
    const scansBeforeCold = snapshotRequests.filter(request => request.forced).length;
    await page.reload();
    await page.locator(".appShell").waitFor();
    await openPage(page, "mods");
    const pendingCache = page.getByText("The first background check has not completed yet. Use Check updates to refresh now.", { exact: true });
    await pendingCache.waitFor();
    assert.equal(await page.getByText("No mods installed yet", { exact: true }).count(), 0, "A cold cache claimed that no mods were installed");
    assert(snapshotRequests.slice(coldStart).every(request => !request.forced), "Opening a cold cache triggered an upstream scan");
    await page.getByRole("button", { name: "Check updates", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".modsWorkspaceIdentity strong")?.textContent === "Polished Library");
    await pendingCache.waitFor({ state: "hidden" });
    assert.equal(snapshotRequests.filter(request => request.forced).length, scansBeforeCold + 1, "Refreshing a cold cache did not use exactly one manual scan");

    nodes[0].status = "offline";
    const offlineStart = snapshotRequests.length;
    await page.reload();
    await page.locator(".appShell").waitFor();
    await openPage(page, "mods");
    await page.waitForFunction(() => document.querySelector(".modsWorkspaceIdentity strong")?.textContent === "Polished Library");
    assert.equal(await page.locator(".modsWorkspaceSwitch input").isDisabled(), true, "Offline cache reads enabled mutations");
    assert(snapshotRequests.slice(offlineStart).every(request => !request.forced), "Offline preloading triggered an upstream scan");
    mod.displayName = "Offline Saved Library";
    await page.evaluate(() => window.pollSavedModSnapshots());
    await page.getByText("Offline Saved Library", { exact: true }).waitFor();
    const offlineLoaded = snapshotRequests.length;
    nodes[0].status = "unknown";
    const appRefreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/app");
    await openPage(page, "settings");
    await appRefreshed;
    await openPage(page, "mods");
    assert.equal(await identity.innerText(), "Offline Saved Library", "A changed node block reason discarded saved mods");
    assert.equal(snapshotRequests.length, offlineLoaded, "A changed node block reason or page revisit refetched saved snapshots");
    assert(snapshotRequests.slice(offlineStart).every(request => !request.forced), "Offline synchronization triggered an upstream scan");
    assert.deepEqual(errors, []);
    console.log("Mod cache and recovery passed: Overview preload, no revisit scans, saved-snapshot polling, one manual scan, cached mutations, cold cache guidance, offline reads, retained data, and retry");
  } finally {
    await context.close();
  }
}

let browser;
try {
  for (const [engine, widths] of [[chromium, [1440, 1024, 768, 390, 320]], [webkit, [320]]]) {
    browser = await launchBrowser(engine);
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: width === 1440 ? "no-preference" : "reduce" });
      await signInThroughApi(context, harness.baseUrl);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${harness.baseUrl}/?mods-fixture=mixed`);
      await page.locator(".appShell").waitFor();
      await openPage(page, "overview");
      await page.locator(".modUpdatesListItem").first().waitFor();
      const events = page.locator(".eventsPanel");
      await events.getByRole("button", { name: /Automation runs/ }).click();
      assert.match(await events.innerText(), /Automation run/);
      await events.getByRole("button", { name: /All events/ }).click();
      if (width >= 1024) {
        await page.locator('.serverTimelinePanel[aria-busy="false"]').waitFor();
        const metrics = page.getByRole("group", { name: "Metric layers" });
        // Toggle a metric without resetting the range or rebuilding the player chart.
        const cpu = metrics.getByRole("button", { name: "CPU", exact: true });
        const chart = await page.locator(".serverTimelinePlayerChart .serverTimelineEChart").elementHandle();
        await cpu.click();
        await cpu.click();
        assert(await chart.evaluate(element => element.isConnected), "Metric toggles rebuilt the player chart");
      }
      await assertNoOverflow(page, ".overviewPage");
      await capture(page, `overview-${engine.name()}-${width}`);
      await page.locator(".modUpdatesListItem").first().click();
      await page.locator(".modsWorkspaceIdentity").first().waitFor();
      const search = page.getByRole("searchbox", { name: "Search installed mods", exact: true });
      await search.fill("  SAFE UPDATE  ");
      await page.waitForFunction(() => document.querySelectorAll(".modsWorkspaceRow:not(.modsWorkspaceSkeletonRow)").length === 1);
      assert.match(await page.locator(".modsWorkspaceListHeader").innerText(), /1 of 5/);
      await search.fill("no-such-installed-mod");
      await page.getByText("No matching mods", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Clear search installed mods", exact: true }).click();
      await assertFocused(search, "Clearing the installed search lost focus");
      await page.waitForFunction(() => document.querySelectorAll(".modsWorkspaceRow").length === 5);
      assert.equal(await page.locator(".modsWorkspaceRow").count(), 5);
      const safeRow = page.locator(".modsWorkspaceRow").filter({ has: page.getByText("Safe Update Fixture", { exact: true }) });
      await safeRow.locator(".modsWorkspaceSwitch").click();
      assert(await safeRow.getByRole("checkbox").isChecked() === false);
      await safeRow.locator(".modsWorkspaceSwitch").click();
      await page.getByRole("button", { name: "Check updates", exact: true }).click();
      await page.getByRole("button", { name: "Check updates", exact: true }).waitFor();
      await assertNoOverflow(page, ".modsWorkspaceInstalled");
      await capture(page, `mods-${engine.name()}-${width}`);

      const add = page.getByRole("button", { name: "Add mods", exact: true });
      await add.click();
      const drawer = page.locator(".modsWorkflowDrawer");
      const modrinthSearch = page.getByRole("searchbox", { name: "Search Modrinth for mods", exact: true });
      await assertFocused(modrinthSearch, "Opening Add mods did not focus search");
      await modrinthSearch.fill("s");
      await drawer.locator(".modsResultCard:not(.isSkeleton)").first().waitFor();
      await modrinthSearch.fill("no-such-modrinth-project");
      await drawer.getByText("No compatible mods found", { exact: true }).waitFor();
      assert.equal(await drawer.locator(".modsResultCard:not(.isSkeleton)").count(), 0, "Previous-query results remained clickable");
      await drawer.getByRole("button", { name: "Clear search modrinth for mods", exact: true }).click();
      await assertFocused(modrinthSearch, "Clearing Modrinth search lost focus");
      await modrinthSearch.fill("s");
      await drawer.getByRole("button", { name: "Review and install: Fabric Mod Helper 1", exact: true }).click();
      await drawer.getByRole("heading", { name: "Choose a version", exact: true }).waitFor();
      await drawer.getByText("Advanced options", { exact: true }).click();
      await drawer.locator('.modsVersionList button[title^="0.9.0"]').click();
      const reviewSelected = drawer.getByRole("button", { name: "Review selected version", exact: true });
      assert(await reviewSelected.isDisabled(), "Risky version review skipped acknowledgement");
      await drawer.locator(".modsRiskAcknowledgement input").check();
      assert(await reviewSelected.isEnabled());
      await drawer.getByRole("button", { name: "Review and install", exact: true }).click();
      const heading = drawer.getByRole("heading", { name: "Review installation", exact: true });
      await heading.waitFor();
      await assertFocused(heading, "Review transition left keyboard focus outside the workflow");
      assert.equal(await drawer.locator(".modsReviewLine span").first().innerText(), "1.0.0", "Recommended action reviewed a previously selected version");
      await assertNoOverflow(page, ".modsDrawerBody");
      if (width <= 720) {
        const opacity = await drawer.evaluate(element => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d");
          context.fillStyle = getComputedStyle(element).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          return context.getImageData(0, 0, 1, 1).data[3];
        });
        assert.equal(opacity, 255, "Phone drawer lets background text bleed through");
      }
      await capture(page, `review-${engine.name()}-${width}`);
      await drawer.getByRole("button", { name: "Back", exact: true }).click();
      await drawer.getByRole("button", { name: "Search", exact: true }).click();
      await assertFocused(modrinthSearch, "Returning to search lost keyboard focus");
      if (width === 1440) {
        await drawer.getByRole("button", { name: "Review and install: Fabric Mod Helper 1", exact: true }).click();
        await drawer.getByRole("button", { name: "Review and install", exact: true }).click();
        const install = drawer.getByRole("button", { name: /^Install mod/ });
        await install.click();
        assert(await drawer.getByRole("button", { name: "Back", exact: true }).isDisabled());
        await page.keyboard.press("Escape");
        assert(await drawer.isVisible(), "Escape dismissed an installation in progress");
        await modrinthSearch.waitFor();
        await assertFocused(modrinthSearch, "Installation completion did not return to search");
      }
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Add mods");
      await assertFocused(add, "Closing the drawer did not restore its trigger");

      await page.getByRole("button", { name: "Update all safe (1)", exact: true }).click();
      await page.locator(".modsWorkspaceBatchAction").waitFor({ state: "hidden" });
      assert.equal(await safeRow.locator(".modsWorkspaceVersion").innerText(), "0.6.0");
      await openPage(page, "overview");
      await page.waitForFunction(() => document.querySelectorAll(".modUpdatesListItem").length === 1);
      assert.equal(await page.locator(".modUpdatesListItem").count(), 1, "Overview retained a completed safe update");
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`Overview and mods interactions passed in ${engine.name()} at ${width}px`);
    }
    if (engine === chromium) await assertRequestRecovery(browser);
    await browser.close();
    browser = undefined;
  }
} finally {
  await browser?.close();
  await harness.stop();
}
