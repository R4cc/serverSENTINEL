import assert from "node:assert/strict";
import { chromium } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-mod-history-smoke-" });
let browser;
try {
  browser = await launchBrowser(chromium);
  for (const width of [1440, 900, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    await signInThroughApi(context, harness.baseUrl);
    await context.addInitScript((theme) => localStorage.setItem("serversentinel-theme", theme), width === 900 || width === 320 ? "light" : "dark");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(harness.baseUrl);
    await page.locator(".appShell").waitFor();
    const nav = page.locator('[data-nav-page="mods"]');
    await nav.waitFor({ state: "attached" });
    if (!await nav.isVisible()) await page.getByRole("button", { name: "Expand navigation" }).click();
    await nav.click();
    await page.locator(".modsWorkspaceInstalled").waitFor();
    const toolbarMetrics = () => page.locator(".tabPage .uiToolbar").evaluate((toolbar) => {
      const button = toolbar.querySelector("button");
      const rect = toolbar.getBoundingClientRect();
      return { height: rect.height, buttonHeight: button.getBoundingClientRect().height, buttonOffset: button.getBoundingClientRect().top - rect.top };
    });
    const modsToolbar = await toolbarMetrics();
    if (width > 720) assert.equal(await page.locator(".modsWorkspacePrimaryActions").getByRole("button", { name: "Update history", exact: true }).count(), 1);
    else await page.getByRole("button", { name: "More actions", exact: true }).waitFor();
    assert.equal(await page.locator(".modsWorkspaceTable").evaluate((table) => table.offsetWidth - table.clientWidth), 0, "Short mod lists must not reserve a blank scrollbar strip");
    const schedulesNav = page.locator('[data-nav-page="schedule"]');
    if (!await schedulesNav.isVisible()) await page.getByRole("button", { name: "Expand navigation" }).click();
    await schedulesNav.click();
    await page.locator(".scheduleWorkspaceToolbar").waitFor();
    const schedulesToolbar = await toolbarMetrics();
    assert.equal(modsToolbar.buttonHeight, schedulesToolbar.buttonHeight, `Toolbar button heights differ at ${width}px`);
    if (width >= 1440) assert.deepEqual(modsToolbar, schedulesToolbar, "Desktop toolbar spacing must match across Mods and Schedules");
    if (!await nav.isVisible()) await page.getByRole("button", { name: "Expand navigation" }).click();
    await nav.click();
    await page.locator(".modsWorkspaceInstalled").waitFor();
    const overflowingButtons = await page.locator(".modsWorkspaceToolbar button").evaluateAll((buttons) => buttons.filter((button) => button.scrollWidth > button.clientWidth + 1).map((button) => button.textContent));
    assert.deepEqual(overflowingButtons, [], `Mods toolbar labels overflow at ${width}px`);
    const openHistory = async () => {
      if (width > 720) await page.getByRole("button", { name: "Update history", exact: true }).click();
      else {
        await page.getByRole("button", { name: "More actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Update history", exact: true }).click();
      }
    };
    const back = () => page.getByRole("button", { name: "Back to mods", exact: true }).click();
    await openHistory();
    await page.getByText("No changes recorded", { exact: true }).waitFor();
    assert.equal(await page.locator(".modsWorkspaceInstalled").count(), 0, "History must be a separate view");
    await back();
    const toggle = page.locator('.modsWorkspaceInstalled input[type="checkbox"]').first();
    await toggle.waitFor({ state: "attached" });
    const previous = await toggle.isChecked();
    const originalToggleLabel = await toggle.getAttribute("aria-label");
    await toggle.locator("..").click();
    await openHistory();
    const rows = page.locator(".modHistoryTable tbody tr");
    await rows.first().waitFor();
    assert.match(await rows.first().innerText(), /demo/);
    assert.match(await rows.first().innerText(), /Enabled|Disabled/);
    assert.match(await rows.first().locator('[data-label="Details"]').innerText(), /^(Enabled|Disabled)\s*→\s*(Enabled|Disabled)$/);
    assert.equal(await rows.first().locator(".modHistoryAction svg").count(), 1);
    assert.equal(await rows.first().locator(".modHistoryIdentity img, .modHistoryIdentity .modsWorkspaceFallback").count(), 1);
    await page.getByRole("button", { name: "About recent changes", exact: true }).click();
    await page.getByRole("tooltip").filter({ hasText: "Revert restores the saved file" }).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    const dialog = page.getByRole("dialog");
    const requestRevert = () => rows.first().getByRole("button", { name: "Revert", exact: true }).click();
    const confirmRevert = () => dialog.getByRole("button", { name: "Revert action", exact: true }).click();
    await requestRevert();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await rows.count(), 1, "Cancel must not change history");
    await requestRevert();
    await confirmRevert();
    await page.getByRole("button", { name: "Reverted", exact: true }).waitFor();
    assert.equal(await rows.count(), 2, "Reverting must add an audit entry");
    await back();
    const restoredToggle = page.getByLabel(originalToggleLabel, { exact: true });
    await restoredToggle.waitFor({ state: "attached" });
    assert.equal(await restoredToggle.isChecked(), previous);
    await page.locator(".modsWorkspaceIdentity").first().click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await dialog.getByRole("button", { name: "Remove mod", exact: true }).click();
    await openHistory();
    await rows.first().waitFor();
    assert.match(await rows.first().innerText(), /removed/i);
    await requestRevert();
    await confirmRevert();
    await page.getByText(/action reverted\./).waitFor();
    // More than one API page catches tables that only sort/filter the first batch.
    await back();
    for (let index = 0; index < 56; index++) {
      const control = page.locator('.modsWorkspaceInstalled input[type="checkbox"]').nth(index % 3);
      const checked = await control.isChecked();
      await control.locator("..").click();
      await page.waitForFunction(({ label, checked }) => {
        const input = [...document.querySelectorAll('.modsWorkspaceInstalled input[type="checkbox"]')].find((entry) => entry.getAttribute("aria-label") === label);
        return input && input.checked !== checked;
      }, { label: await control.getAttribute("aria-label"), checked });
    }
    await openHistory();
    await page.getByText("Showing 1–25 of 60 changes", { exact: true }).waitFor();
    assert.equal(await rows.count(), 25);
    const scroll = page.getByRole("region", { name: "Mod history table", exact: true });
    const pager = page.getByRole("navigation", { name: "changes pagination" });
    await pager.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByText("Showing 26–50 of 60 changes", { exact: true }).waitFor();
    for (const label of ["Mod", "Action", "Details", "Date", "User"]) {
      const header = page.locator(".modHistoryTable th").filter({ has: page.getByRole("button", { name: new RegExp(`^${label}`) }) });
      await header.getByRole("button").click();
      assert.notEqual(await header.getAttribute("aria-sort"), "none");
      await page.getByText("Showing 1–25 of 60 changes", { exact: true }).waitFor();
    }
    const modHeader = page.locator(".modHistoryTable th").first();
    await modHeader.getByRole("button").click();
    for (const direction of ["ascending", "descending"]) {
      assert.equal(await modHeader.getAttribute("aria-sort"), direction);
      const sortedNames = await rows.locator(".modHistoryIdentity strong").allTextContents();
      assert.deepEqual(sortedNames, [...sortedNames].sort((a, b) => (direction === "ascending" ? 1 : -1) * a.toLowerCase().localeCompare(b.toLowerCase())));
      if (direction === "ascending") await modHeader.getByRole("button").click();
    }
    await page.getByRole("searchbox", { name: "Search history", exact: true }).fill("removed");
    await page.getByText("Showing 1–1 of 1 changes", { exact: true }).waitFor();
    assert.match(await rows.first().innerText(), /removed/i);
    await page.getByRole("searchbox", { name: "Search history", exact: true }).fill("does-not-exist");
    await page.getByText("No matching changes", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Clear search history", exact: true }).click();
    await page.getByText("Showing 1–25 of 60 changes", { exact: true }).waitFor();
    await scroll.scrollIntoViewIfNeeded();
    await scroll.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => {
      const element = document.querySelector(".modHistoryTableScroll");
      return element.scrollTop > 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
    });
    const metrics = await scroll.evaluate((element) => {
      const header = element.querySelector("thead").getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      element.scrollLeft = element.scrollWidth;
      return { top: rect.top, headerTop: header.top, height: rect.height, bottom: rect.bottom, viewport: innerHeight, x: element.scrollLeft, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    });
    assert.ok(Math.abs(metrics.headerTop - metrics.top) < 2, "Table header must stay visible while scrolling");
    if (width > 720) assert.ok(metrics.bottom <= metrics.viewport + 1, "Desktop/tablet history must fit the workspace");
    if (metrics.scrollWidth > metrics.clientWidth) assert.ok(metrics.x > 0, "Wide history must scroll horizontally");
    await pager.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByText("Showing 26–50 of 60 changes", { exact: true }).waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await scroll.evaluate((element) => element.scrollTop), 0, "Changing pages starts at the first row");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Page overflow at ${width}px`);
    if (process.env.MOD_HISTORY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.MOD_HISTORY_SCREENSHOT_DIR}/mod-history-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`Mod history, cancel, revert, deletion recovery and layout passed at ${width}px`);
  }
} finally {
  await browser?.close();
  await harness.stop();
}
