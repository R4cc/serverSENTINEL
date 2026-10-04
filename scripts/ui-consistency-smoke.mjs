import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-ui-consistency-" });

async function openPage(page, name) {
  const nav = page.locator(`[data-nav-page="${name}"]`);
  await nav.waitFor({ state: "attached" });
  if (!await nav.isVisible()) await page.getByRole("button", { name: "Expand navigation" }).click();
  await nav.click();
  await page.locator(`.workspacePage-${name}`).waitFor();
}

async function checkLayout(page, surface) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "Document overflows");
  assert.equal(await surface.evaluate(element => element.scrollWidth > element.clientWidth + 1), false, "Surface overflows");
}

async function checkField(input) {
  const field = input.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' uiFormField ')][1]");
  const label = field.locator(".uiFormFieldLabel");
  assert.equal(await label.getAttribute("for"), await input.getAttribute("id"));
  const styles = await label.evaluate(element => {
    const style = getComputedStyle(element);
    return { size: style.fontSize, expected: style.getPropertyValue("--type-form-label-size").trim() };
  });
  assert.equal(styles.size, styles.expected, "Form label deviates from the shared text scale");
  await label.click();
  assert(await input.evaluate(element => element === document.activeElement), "Label does not focus its control");
}

try {
  for (const [engine, name, width, theme] of [
    [chromium, "desktop", 1440, "dark"],
    [chromium, "tablet", 768, "light"],
    [chromium, "phone", 390, "dark"],
    [webkit, "small-phone", 320, "light"]
  ]) {
    const browser = await launchBrowser(engine);
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      await context.addInitScript(theme => localStorage.setItem("serversentinel-theme", theme), theme);
      await signInThroughApi(context, harness.baseUrl);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      // Exercise editable settings with the harness-owned admin account. Demo presentation
      // intentionally locks credentials and users; only this browser's session flag changes.
      const sessionRoute = async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), demo: false } });
      };
      await page.route("**/api/auth/session", sessionRoute);
      const usersRoute = route => route.fulfill({ json: { users: [
        { id: "ui-viewer", username: "AtlasViewer", rolePreset: "viewer", permissions: ["servers.view"], createdAt: "2026-10-04T00:00:00.000Z" },
        { id: "ui-operator", username: "OperatorWithALongDisplayName", rolePreset: "operator", permissions: ["servers.view"], createdAt: "2026-10-04T00:00:00.000Z" }
      ] } });
      await page.route("**/api/users", usersRoute);
      await page.goto(harness.baseUrl);
      await page.locator(".appShell").waitFor();

      await openPage(page, "settings");
      if (width <= 720) await page.getByRole("combobox", {name:"Settings category"}).selectOption("integrations");
      else await page.getByRole("tab", { name: "Integrations", exact: true }).click();
      await page.locator('input[name="modrinthApiKey"], .keyFormConfigured .keyFormActions button').first().waitFor();
      const replace = page.getByRole("button", { name: "Replace key", exact: true });
      if (await replace.count()) await replace.click();
      const key = page.getByLabel(/^(New )?Modrinth API key/);
      await checkField(key);
      await checkLayout(page, page.locator(".settingsHubContent"));
      const keyForm = key.locator("xpath=ancestor::form");
      if (await keyForm.getByRole("button", { name: "Cancel", exact: true }).count()) await keyForm.getByRole("button", { name: "Cancel", exact: true }).click();

      if (width <= 720) await page.getByRole("combobox", {name:"Settings category"}).selectOption("users");
      else await page.getByRole("tab", { name: "Users", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search users and roles" }).waitFor();
      await checkLayout(page, page.locator(".settingsHubContent"));
      assert.equal(await page.locator(".usersTable tbody tr").count(), 2);
      assert.equal(await page.locator(".usersSettings").evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", "User management still nests an opaque panel inside Settings");
      const userSearch = page.getByRole("searchbox", { name: "Search users and roles" });
      await userSearch.fill("AtlasViewer");
      assert.equal(await page.locator(".usersTable tbody tr").count(), 1);
      await page.getByRole("button", { name: "Clear search users and roles", exact: true }).click();
      if (process.env.UI_CONSISTENCY_SCREENSHOTS) {
        await mkdir(process.env.UI_CONSISTENCY_SCREENSHOTS, { recursive: true });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.screenshot({ path: `${process.env.UI_CONSISTENCY_SCREENSHOTS}/settings-users-${name}.png`, fullPage: true });
      }
      await page.getByRole("button", { name: "New user", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "New user", exact: true });
      const close = dialog.getByRole("button", { name: "Close user dialog", exact: true });
      assert(await close.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), "The navigation covers the dialog's close button");
      await checkField(dialog.getByLabel(/^Username/));
      await checkField(dialog.getByLabel(/^Password/));
      await checkField(dialog.getByLabel("Role preset", { exact: true }));
      await checkLayout(page, dialog);
      if (process.env.UI_CONSISTENCY_SCREENSHOTS) {
        await mkdir(process.env.UI_CONSISTENCY_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: `${process.env.UI_CONSISTENCY_SCREENSHOTS}/users-${name}.png` });
      }
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

      await page.unroute("**/api/auth/session", sessionRoute);
      await page.unroute("**/api/users", usersRoute);
      await page.reload();
      await page.locator(".appShell").waitFor();

      await openPage(page, "mods");
      await page.locator(".modsWorkspaceRow").first().waitFor();
      const installed = page.getByRole("searchbox", { name: "Search installed mods", exact: true });
      await installed.fill("no-such-mod");
      await page.getByRole("button", { name: "Clear search installed mods", exact: true }).click();
      assert.equal(await installed.inputValue(), "");
      assert(await installed.evaluate(element => element === document.activeElement));
      await checkLayout(page, page.locator(".modsWorkspaceInstalled"));
      await page.getByRole("button", { name: "Add mods", exact: true }).click();
      const search = page.getByRole("searchbox", { name: "Search Modrinth for mods", exact: true });
      await search.fill("fabric");
      await page.getByRole("button", { name: "Clear search modrinth for mods", exact: true }).click();
      assert.equal(await search.inputValue(), "");
      assert(await search.evaluate(element => element === document.activeElement));
      await checkLayout(page, page.locator(".modsWorkflowDrawer"));
      if (process.env.UI_CONSISTENCY_SCREENSHOTS) await page.screenshot({ path: `${process.env.UI_CONSISTENCY_SCREENSHOTS}/mods-${name}.png` });
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`Shared fields, search focus, and responsive layout passed: ${name}, ${width}px, ${theme}`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await harness.stop();
}
