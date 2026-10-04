import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-schedules-ui-" });
const screenshots = process.env.SCHEDULES_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });

async function capture(page, name, dialog = false) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Page overflows");
  for (const selector of [".scheduleTableCard", ".scheduleTableFrame", ".scheduleTableRow", ".scheduledRunsFeed", ".scheduleModalPanel", ".scheduleEditBody", ".scheduleStepCard"]) {
    for (const element of await page.locator(selector).all()) {
      assert(await element.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${selector} overflows`);
    }
  }
  if (dialog) {
    assert(await page.locator(".scheduleModalPanel").evaluate(element => {
      const box = element.getBoundingClientRect();
      const footer = element.querySelector(".scheduleModalFooter").getBoundingClientRect();
      return box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && footer.bottom <= innerHeight + 1;
    }), "Editor or save controls leave the viewport");
  }
  if (screenshots) await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: !dialog, animations: "disabled" });
}

async function action(page, name, command) {
  const trigger = page.getByRole("button", { name: `Actions for ${name}`, exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await trigger.click();
  await page.getByRole("menuitem", { name: command, exact: true }).click();
}

async function waitForCount(page, count) {
  await page.waitForFunction(count => document.querySelectorAll(".scheduleTableRow").length === count, count);
}

try {
  for (const [engine, width, theme] of [
    [chromium, 1440, "dark"], [chromium, 1440, "light"],
    [chromium, 1024, "dark"], [chromium, 768, "light"],
    [chromium, 390, "dark"], [webkit, 320, "light"]
  ]) {
    const browser = await launchBrowser(engine);
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      await context.addInitScript(theme => {
        localStorage.setItem("serversentinel-theme", theme);
        localStorage.setItem("serversentinel-active-page", JSON.stringify({ value: "schedule", savedAt: Date.now() }));
      }, theme);
      await signInThroughApi(context, harness.baseUrl);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      // Every mutation below is handled by the app's browser-only demo schedules.
      await page.route("**/api/servers/**/schedules**", route => {
        assert.equal(route.request().method(), "GET", "Demo made a schedule mutation request");
        return route.continue();
      });
      try {
        await page.goto(harness.baseUrl);
        await page.locator(".scheduleTableRow").waitFor();
        await page.evaluate(() => document.fonts.ready);
        await capture(page, `${width}-${theme}-initial`);
        const recentRun = page.locator(".scheduledRunItem").first();
        await recentRun.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        const restingBounds = await recentRun.boundingBox();
        await recentRun.hover();
        assert.deepEqual(await recentRun.boundingBox(), restingBounds, "Hover changes recent-run geometry");
        assert(await recentRun.evaluate(element => {
          const style = getComputedStyle(element);
          const row = element.getBoundingClientRect();
          const marker = element.querySelector('.scheduledRunMarker').getBoundingClientRect();
          const action = element.querySelector('.scheduledRunActions').getBoundingClientRect();
          return parseFloat(style.borderTopLeftRadius) >= 6
            && marker.left - row.left >= 10 && row.right - action.right >= 10;
        }), "Recent-run hover must be rounded and inset on both sides");
        if (screenshots) await recentRun.screenshot({ path: `${screenshots}/${width}-${theme}-recent-hover.png`, animations: "disabled" });
        const recentDetails = recentRun.getByRole("button", { name: /^View details/ });
        await recentDetails.focus();
        await page.mouse.move(0, 0);
        assert(await recentRun.evaluate(element => element.matches(':focus-within')), "Recent-run keyboard focus is missing");
        assert.deepEqual(await recentRun.boundingBox(), restingBounds, "Keyboard focus changes recent-run geometry");
        await recentDetails.click();
        await page.locator(".scheduleRunModalPanel").waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".scheduleRunModalPanel").waitFor({ state: "detached" });
        for (const [template, name] of [["Nightly restart", "Nightly restart"], ["Hourly save", "Hourly world save"], ["Weekly restart when empty", "Weekly restart when empty"]]) {
          await page.getByRole("button", { name: "Add schedule", exact: true }).click();
          const modal = page.locator(".scheduleModalPanel");
          await modal.getByLabel("Time of day", { exact: true }).waitFor();
          await modal.getByRole("button", { name: new RegExp(`^${template}`) }).click();
          await modal.getByLabel("Name", { exact: true }).fill(name);
          if (template === "Weekly restart when empty") {
            assert(await modal.getByLabel("Wait until empty", { exact: true }).isChecked());
            assert(await modal.getByLabel("Monday", { exact: true }).isChecked());
            assert.equal(await modal.getByLabel("Time of day", { exact: true }).inputValue(), "05:00");
          }
          if (template === "Nightly restart") {
            assert.equal(await modal.locator(".scheduleStepCard").count(), 4);
            await capture(page, `${width}-${theme}-editor`, true);
            await modal.getByRole("button", { name: "Move step 1 down", exact: true }).click();
            assert.equal(await modal.locator(".scheduleStepCard").first().getByLabel("Delay before step 1", { exact: true }).inputValue(), "4");
            await modal.getByRole("button", { name: "Move step 2 up", exact: true }).click();
          }
          await modal.getByRole("button", { name: "Create schedule", exact: true }).click();
          await modal.waitFor({ state: "detached" });
          await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).waitFor();
        }
        await waitForCount(page, 4);
        await capture(page, `${width}-${theme}-list`);
        const search = page.getByRole("searchbox", { name: "Search schedules" });
        await search.fill("HOURLY");
        await waitForCount(page, 1);
        await page.getByRole("button", { name: "Clear search schedules", exact: true }).click();
        assert(await search.evaluate(element => element === document.activeElement));
        await waitForCount(page, 4);
        const filter = page.getByRole("combobox", { name: "Filter schedules" });
        await filter.selectOption("paused");
        await page.getByText("No matching schedules", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Clear filters", exact: true }).click();
        await waitForCount(page, 4);
        await page.getByRole("button", { name: "Actions for Hourly world save", exact: true }).locator("xpath=ancestor::article").locator(".scheduleTableSwitch").click();
        await page.getByLabel("Enable Hourly world save", { exact: true }).waitFor({ state: "attached" });
        await filter.selectOption("paused");
        await waitForCount(page, 1);
        assert(await page.locator(".scheduleTableRow").getByText("Paused", { exact: true }).isVisible());
        await filter.selectOption("all");
        await action(page, "Hourly world save", "Duplicate");
        const modal = page.locator(".scheduleModalPanel");
        await page.waitForFunction(() => document.querySelector('.scheduleModalPanel input[name="name"]')?.value === "Hourly world save copy");
        assert.equal(await modal.getByLabel("Name", { exact: true }).inputValue(), "Hourly world save copy");
        await modal.getByLabel("Name", { exact: true }).fill("Delayed world save");
        await modal.getByLabel("Enabled", { exact: true }).check();
        await modal.getByLabel("Delay before step 1", { exact: true }).fill("5");
        await modal.getByRole("button", { name: "Create schedule", exact: true }).click();
        await modal.waitFor({ state: "detached" });
        await waitForCount(page, 5);
        await action(page, "Delayed world save", "Run now");
        const cancel = page.getByRole("button", { name: "Cancel Delayed world save", exact: true });
        await cancel.waitFor();
        await capture(page, `${width}-${theme}-running`);
        await page.getByRole("button", { name: "Actions for Delayed world save", exact: true }).click();
        assert(await page.getByRole("menuitem", { name: "Run now", exact: true }).isDisabled(), "Active run can be started twice");
        await page.keyboard.press("Escape");
        await cancel.click();
        await page.getByRole("button", { name: "Cancel run", exact: true }).click();
        await cancel.waitFor({ state: "detached" });
        await page.getByRole("button", { name: "View details for Delayed world save", exact: true }).click();
        await page.locator(".scheduleRunModalPanel").waitFor();
        await capture(page, `${width}-${theme}-details`);
        await page.keyboard.press("Escape");
        await page.locator(".scheduleRunModalPanel").waitFor({ state: "detached" });
        await action(page, "Nightly backup", "View runs");
        await page.locator(".scheduleHistoryPanel").waitFor();
        await capture(page, `${width}-${theme}-history`);
        await page.locator(".scheduleHistoryPanel").getByRole("button", { name: /^View details/ }).click();
        await page.locator(".scheduleRunLogs").first().locator("summary").click();
        await page.getByText("[Server thread/INFO]: Saved the game", { exact: false }).waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".scheduleHistoryPanel").waitFor();
        await page.keyboard.press("Escape");
        await action(page, "Hourly world save", "Edit");
        await modal.getByLabel("Name", { exact: true }).fill("Paused hourly save");
        await modal.getByRole("combobox", { name: "How often this schedule repeats" }).selectOption("advanced");
        await modal.locator(".scheduleCronField input").fill("not cron");
        await modal.getByRole("button", { name: "Save changes", exact: true }).click();
        await modal.getByText("Check schedule details", { exact: true }).waitFor();
        await capture(page, `${width}-${theme}-invalid`, true);
        await modal.locator(".scheduleCronField input").fill("0 8 * * 1");
        await modal.getByRole("button", { name: "Save changes", exact: true }).click();
        await modal.waitFor({ state: "detached" });
        await action(page, "Paused hourly save", "Delete");
        await page.getByRole("button", { name: "Delete schedule", exact: true }).click();
        await waitForCount(page, 4);
        await filter.selectOption("enabled");
        await waitForCount(page, 4);
        for (let occurrence = 0; occurrence < 3; occurrence += 1) {
          await action(page, "Nightly backup", "Run now");
          await page.getByRole("button", { name: "Run schedule", exact: true }).click();
          await page.locator(".confirmationBackdrop").waitFor({ state: "detached" });
        }
        await filter.selectOption("attention");
        await waitForCount(page, 1);
        assert(await page.locator(".scheduleHealthBadge").getByText("Skipped 3 runs in a row", { exact: true }).isVisible());
        assert.equal(await page.locator(".scheduleTableRow .scheduleStatusIcon.failed").count(), 0);
        await capture(page, `${width}-${theme}-attention`);
        await filter.selectOption("all");
        assert.deepEqual(errors, []);
        console.log(`Schedules UI passed: ${width}px ${theme}`);
      } finally { await context.close(); }
    } finally { await browser.close(); }
  }
} finally { await harness.stop(); }
