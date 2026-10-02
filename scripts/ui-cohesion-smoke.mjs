import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-ui-cohesion-" });
const screenshots = process.env.UI_COHESION_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });

async function navigate(page, name) {
  const target = page.locator(`[data-nav-page="${name}"]`);
  if (!await target.isVisible()) await page.getByRole("button", { name: "Expand navigation" }).click();
  await target.click();
  await page.locator(`.workspacePage-${name}`).waitFor();
}

async function checkOverflow(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Page overflows horizontally");
}

async function snapshot(page, name) {
  await checkOverflow(page);
  if (screenshots) await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: !/dialog|editor/.test(name) });
}

async function checkDialog(page, dialog, phone) {
  await dialog.waitFor();
  assert(await dialog.evaluate(element => element.contains(document.activeElement)), "Dialog did not acquire focus");
  if (phone) {
    const geometry = await dialog.evaluate(element => {
      const box = element.getBoundingClientRect();
      const footer = element.querySelector("footer")?.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight, footerBottom: footer?.bottom };
    });
    assert(Math.abs(geometry.x) <= 1 && Math.abs(geometry.y) <= 1 && Math.abs(geometry.width - geometry.viewportWidth) <= 1 && Math.abs(geometry.height - geometry.viewportHeight) <= 1, `Mobile dialog does not fill the viewport: ${JSON.stringify(geometry)}`);
    if (geometry.footerBottom) assert(geometry.footerBottom <= geometry.viewportHeight + 1, "Dialog footer is outside the viewport");
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "hidden", "Dialog leaves background scrolling unlocked");
    const originalViewport = page.viewportSize();
    await page.setViewportSize({ ...originalViewport, height: 520 });
    await page.waitForFunction(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--visual-viewport-height")) === 520);
    assert(await dialog.evaluate(element => {
      const box = element.getBoundingClientRect();
      const footer = element.querySelector("footer")?.getBoundingClientRect();
      return Math.abs(box.height - innerHeight) <= 1 && (!footer || footer.bottom <= innerHeight + 1);
    }), "Dialog and actions do not adapt to a shorter viewport");
    await page.setViewportSize(originalViewport);
    await page.waitForFunction(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--visual-viewport-height")) === innerHeight);
  }
  const last = dialog.locator('button:visible:not([disabled]), input:visible:not([disabled]), select:visible:not([disabled]), textarea:visible:not([disabled]), a:visible[href], [tabindex="0"]:visible').last();
  await last.focus();
  await page.keyboard.press("Tab");
  assert(await dialog.evaluate(element => element.contains(document.activeElement)), "Tab escaped the dialog");
  await checkOverflow(page);
}

try {
  for (const width of [1440, 768, 390, 320]) {
    for (const theme of ["light", "dark"]) {
      const browser = await launchBrowser(width === 320 ? webkit : chromium);
      try {
        const phone = width <= 720;
        const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: phone, reducedMotion: "reduce" });
        await context.addInitScript(theme => localStorage.setItem("serversentinel-theme", theme), theme);
        await signInThroughApi(context, harness.baseUrl);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(harness.baseUrl);
        await page.locator(".appShell").waitFor();
        const label = `${width}-${theme}`;

        await navigate(page, "mods");
        await page.locator(".modsWorkspaceRow").first().waitFor();
        if (phone) {
          const toggle = page.getByRole("button", { name: "Server controls", exact: true });
          assert.equal(await toggle.getAttribute("aria-expanded"), "false");
          assert.equal(await page.getByRole("button", { name: "Restart", exact: true }).isVisible(), false);
          await toggle.click();
          assert(await page.getByRole("button", { name: "Restart", exact: true }).isVisible());
          await toggle.click();
          assert.equal(await toggle.getAttribute("aria-expanded"), "false");
          await page.getByRole("button", { name: "More actions", exact: true }).click();
          assert(await page.getByRole("menuitem", { name: "Upload jar", exact: true }).isVisible());
          assert(await page.getByRole("menuitem", { name: "Update history", exact: true }).isVisible());
          await page.keyboard.press("Escape");
          assert.equal(await page.getByRole("button", { name: "More actions", exact: true }).evaluate(element => element === document.activeElement), true);
          const contentTop = await page.locator(".modsWorkspaceInstalled").evaluate(element => element.getBoundingClientRect().top);
          assert(contentTop < 370, `Mods content remains too far down: ${contentTop}`);
        }
        const add = page.getByRole("button", { name: "Add mods", exact: true });
        const batch = page.locator(".modsWorkspaceBatchAction");
        if (await batch.count()) {
          assert(await batch.evaluate(element => element.classList.contains("uiButton--primary")));
          assert(await add.evaluate(element => element.classList.contains("uiButton--secondary")));
        }
        await snapshot(page, `${label}-mods`);
        await add.click();
        await checkDialog(page, page.getByRole("dialog", { name: "Add mods", exact: true }), phone);
        await snapshot(page, `${label}-mods-dialog`);
        await page.keyboard.press("Escape");
        await page.getByRole("dialog", { name: "Add mods", exact: true }).waitFor({ state: "detached" });
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Add mods");
        assert(await add.evaluate(element => element === document.activeElement), "Add mods did not regain focus");

        await navigate(page, "files");
        await page.getByRole("table", { name: "Server files", exact: true }).waitFor();
        assert.equal(await page.locator(".fileDetailsPanel").count(), 0, "Empty inspector still consumes space");
        const file = page.getByRole("rowheader", { name: "server.properties", exact: true });
        await file.click();
        if (width >= 981) assert(await page.locator(".fileDetailsPanel").isVisible(), "Selected file has no inspector");
        if (phone) {
          assert(await page.getByRole("button", { name: "Upload file" }).locator(".fileToolbarLabel").isVisible(), "Upload has no visible label");
          assert(await page.getByRole("button", { name: "New folder", exact: true }).locator(".fileToolbarLabel").isVisible(), "New folder has no visible label");
          await page.getByRole("button", { name: "More folder navigation" }).click();
          assert(await page.getByRole("menuitem", { name: "Go to server root" }).isVisible());
          await page.keyboard.press("Escape");
        }
        await snapshot(page, `${label}-files`);
        await file.dblclick();
        const editor = page.getByRole("dialog", { name: "server.properties", exact: true });
        await editor.locator(".cm-editor").waitFor();
        await checkDialog(page, editor, phone);
        assert(await editor.locator(".fileEditorRestrictionReason").isVisible(), "Editing restriction is not visible");
        assert.match(await editor.locator(".fileEditorRestrictionReason").innerText(), /Stop the server/);
        assert(await editor.getByRole("button", { name: "Close", exact: true }).isVisible());
        await snapshot(page, `${label}-file-editor`);
        await editor.getByRole("button", { name: "Close editor", exact: true }).click();

        await navigate(page, "settings");
        await page.locator('.settingsHub[aria-busy="false"]').waitFor();
        if (phone) {
          const picker = page.getByRole("combobox", { name: "Settings category" });
          assert(await picker.isVisible());
          assert.equal(await page.getByRole("tablist", { name: "Settings categories" }).isVisible(), false);
          await picker.selectOption("console");
          assert(await page.getByRole("combobox", { name: "Terminal font size" }).isVisible());
          await picker.selectOption("appearance");
        }
        await snapshot(page, `${label}-settings`);

        await navigate(page, "players");
        await page.locator(".playerRosterCard").waitFor();
        if (phone) {
          assert.equal(await page.locator(".playerMap").count(), 0, "Collapsed geography still mounts a map");
          const rosterTop = await page.locator(".playerRosterCard").evaluate(element => element.getBoundingClientRect().top);
          const summaryTop = await page.locator(".playerSummaryGrid").evaluate(element => element.getBoundingClientRect().top);
          assert(rosterTop < summaryTop, "Players roster does not lead on phones");
          await snapshot(page, `${label}-players`);
          const geography = page.getByRole("button", { name: "Player geography", exact: true });
          await geography.click();
          await page.locator(".playerMapCanvas").waitFor();
          await page.getByRole("button", { name: "Zoom in", exact: true }).click();
          await geography.click();
          assert.equal(await page.locator(".playerMap").count(), 0);
        } else await snapshot(page, `${label}-players`);

        await navigate(page, "schedule");
        await page.getByRole("table", { name: "Schedules", exact: true }).waitFor();
        const panelHeight = await page.locator(".scheduleTableCard").evaluate(element => element.getBoundingClientRect().height);
        assert(panelHeight < 500, `Short schedule list reserves empty space: ${panelHeight}`);
        await snapshot(page, `${label}-schedules`);
        await page.getByRole("button", { name: "Add schedule", exact: true }).click();
        await checkDialog(page, page.locator(".scheduleModalPanel"), phone);
        await snapshot(page, `${label}-schedule-dialog`);
        await page.keyboard.press("Escape");
        await page.locator(".scheduleModalPanel").waitFor({ state: "detached" });

        await navigate(page, "nodes");
        const details = page.getByRole("button", { name: "Details", exact: true }).first();
        await details.scrollIntoViewIfNeeded();
        const scrollBeforeDetails = await page.evaluate(() => document.scrollingElement.scrollTop);
        await details.click();
        await checkDialog(page, page.locator(".nodeDetailsDrawer"), phone);
        if (phone) assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), scrollBeforeDetails, "Opening details loses the fleet scroll position");
        await snapshot(page, `${label}-node-dialog`);
        await page.keyboard.press("Escape");
        await page.locator(".nodeDetailsDrawer").waitFor({ state: "detached" });
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Details");
        assert(await details.evaluate(element => element === document.activeElement), "Node details did not regain focus");
        assert.equal(errors.length, 0, errors.join("\n"));
        console.log(`UI cohesion passed: ${label}`);
      } finally { await browser.close(); }
    }
  }
} finally { await harness.stop(); }
