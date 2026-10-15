import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createBrowserPool, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";
import { checkSpacing, checkBannerVariants } from "./lib/ui-spacing.mjs";

const widths = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [1440, 768, 390, 320];
assert(widths.every(width => Number.isInteger(width) && width >= 320), "Viewport widths must be integers of at least 320px");
let harness;
const screenshots = process.env.ICON_SPACING_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });

async function navigate(page, name) {
  const target = page.locator(`[data-nav-page="${name}"]`);
  await target.waitFor({ state: "attached" });
  if (!await target.isVisible()) await page.getByRole("button", { name: "Expand navigation" }).click();
  await checkSpacing(page, `${name} navigation`);
  await target.click();
  await page.locator(`.workspacePage-${name}`).waitFor();
}

const browsers = createBrowserPool();
try {
  for (const width of widths) {
    await harness?.stop();
    harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-icon-spacing-" });
    for (const theme of ["light", "dark"]) {
      const browser = await browsers.get(width === 320 ? webkit : chromium);
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      try {
        await context.addInitScript(theme => localStorage.setItem("serversentinel-theme", theme), theme);
        await signInThroughApi(context, harness.baseUrl);
        const page = await context.newPage();
        await page.goto(harness.baseUrl);
        await page.locator(".appShell").waitFor();
        const label = `${width}-${theme}`;
        if (width > 1100) {
          await page.getByRole("button", { name: "Collapse navigation" }).click();
          await checkSpacing(page, `${label} collapsed navigation`);
          await page.getByRole("button", { name: "Expand navigation" }).click();
        }
        for (const name of ["overview", "console", "files", "mods", "players", "schedule", "properties", "nodes", "settings"]) {
          await navigate(page, name);
          const ready = {
            overview: ".overviewSummary", console: ".minecraftTerminal:not(.initializing)", files: ".fileTableRow",
            mods: ".modsWorkspaceRow", players: ".playerRosterTable", schedule: ".scheduleTableCard",
            properties: ".propertiesSection", nodes: ".nodeListRow", settings: '.settingsHub[aria-busy="false"]'
          }[name];
          await page.locator(ready).first().waitFor();
          await checkSpacing(page, `${label} ${name}`);
          if (width <= 720 && name === "console") {
            const toggle = page.getByRole("button", { name: "Server controls", exact: true });
            await toggle.click();
            await checkSpacing(page, `${label} expanded controls`);
            await toggle.click();
          }
          if (name === "mods") {
            await page.locator(".modsWorkspaceIdentity").first().click();
            await page.locator(".modsDetailsDrawer").waitFor();
            await checkSpacing(page, `${label} mod details`);
            await page.keyboard.press("Escape");
            await page.getByRole("button", { name: "Add mods", exact: true }).click();
            await page.getByRole("dialog", { name: "Add mods", exact: true }).waitFor();
            await checkSpacing(page, `${label} mods dialog`);
            await page.keyboard.press("Escape");
          }
          if (name === "files") {
            await page.getByRole("rowheader", { name: "server.properties", exact: true }).click();
            await page.getByRole("button", { name: "Open selected file", exact: true }).click();
            const editor = page.getByRole("dialog", { name: "server.properties", exact: true });
            await editor.locator(".cm-editor").waitFor();
            await checkSpacing(page, `${label} file editor`);
            await editor.getByRole("button", { name: "Close editor", exact: true }).click();
          }
          if (name === "schedule") {
            await page.getByRole("button", { name: "Add schedule", exact: true }).click();
            await page.locator(".scheduleModalPanel").waitFor();
            await checkSpacing(page, `${label} schedule dialog`);
            await page.keyboard.press("Escape");
          }
          if (name === "nodes") {
            await page.getByRole("button", { name: "Details", exact: true }).first().click();
            await page.locator(".nodeDetailsDrawer").waitFor();
            await checkSpacing(page, `${label} node dialog`);
            await page.keyboard.press("Escape");
          }
          if (name === "settings") {
            for (const category of ["console", "integrations", "modules", "system"]) {
              if (width <= 720) await page.getByRole("combobox", { name: "Settings category" }).selectOption(category);
              else await page.locator(`#settings-tab-${category}`).click();
              await page.locator(`#settings-panel-${category}`).waitFor();
              await checkSpacing(page, `${label} settings ${category}`);
            }
          }
          if (screenshots) await page.screenshot({ path: `${screenshots}/${label}-${name}.png`, fullPage: true });
        }
        await checkBannerVariants(page, label);
        if (screenshots) await page.screenshot({ path: `${screenshots}/${label}-error.png`, fullPage: true });
        console.log(`Icon and banner spacing passed: ${label}`);
      } finally { await context.close(); }
    }
  }
} finally { await browsers.close().finally(() => harness?.stop()); }
