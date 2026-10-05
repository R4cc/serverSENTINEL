import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

const widths = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [1440, 768, 390, 320];
assert(widths.every(width => Number.isInteger(width) && width >= 320), "Viewport widths must be integers of at least 320px");
const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-icon-spacing-" });
const screenshots = process.env.ICON_SPACING_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });

async function checkSpacing(page, label) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await page.evaluate(() => {
    const issues = [];
    let icons = 0;
    let banners = 0;
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
    const contains = (outer, inner, inset = 0) => inner.left >= outer.left + inset - 1 && inner.right <= outer.right - inset + 1
      && inner.top >= outer.top + inset - 1 && inner.bottom <= outer.bottom - inset + 1;
    for (const svg of document.querySelectorAll("svg")) {
      if (!visible(svg)) continue;
      const parent = svg.parentElement;
      const button = svg.closest("button, a.uiButton");
      const iconOnly = button && (button.classList.contains("uiButton--icon")
        || button.classList.contains("iconButton") || button.classList.contains("iconOnlyButton")
        || button.matches(".sidebarCollapsed .sideNav button")
        || (!button.textContent.trim() && !button.querySelector("img")) || Number.parseFloat(getComputedStyle(button).fontSize) === 0);
      const well = [...parent.classList].some(name => /(?:Icon|icon|Marker)$/.test(name)) && !parent.matches("svg");
      if (button && visible(button)) {
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        const bordered = Number.parseFloat(style.borderWidth) > 0 && style.borderColor !== "rgba(0, 0, 0, 0)";
        if (bordered && !contains(box, svg.getBoundingClientRect(), 4)) issues.push(`Button icon lacks padding: ${button.getAttribute("aria-label") || button.className}`);
      }
      const container = iconOnly ? button : well ? parent : null;
      if (!container || !visible(container)) continue;
      const box = container.getBoundingClientRect();
      const glyph = svg.getBoundingClientRect();
      if (box.width < glyph.width || box.height < glyph.height) continue;
      // Composite event icons deliberately overlay a player head and a smaller status glyph.
      if (container.closest(".eventIcon--withPlayerHead, .timelineAnnotationIconStack")) continue;
      icons++;
      const name = container.getAttribute("aria-label") || container.getAttribute("title") || container.className;
      if (Math.abs(box.left + box.width / 2 - glyph.left - glyph.width / 2) > 1
        || Math.abs(box.top + box.height / 2 - glyph.top - glyph.height / 2) > 1) issues.push(`Off-center icon: ${name}`);
      if (box.width >= glyph.width + 8 && box.height >= glyph.height + 8 && !contains(box, glyph, 4)) issues.push(`Icon touches border: ${name}`);
    }
    for (const banner of document.querySelectorAll(".uiBanner")) {
      if (!visible(banner)) continue;
      banners++;
      const box = banner.getBoundingClientRect();
      const style = getComputedStyle(banner);
      const compact = banner.classList.contains("uiBanner--compact");
      const minimum = compact ? 8 : 12;
      if (banner.closest("#spacing-banner-fixtures") && compact
        && (Number.parseFloat(style.paddingTop) !== 8 || Number.parseFloat(style.paddingBottom) !== 8)) {
        issues.push("Compact banner lost its vertical padding");
      }
      if (banner.classList.contains("inlineState")) {
        banner.classList.remove("inlineState");
        const plainStyle = getComputedStyle(banner);
        const plainAppearance = [plainStyle.background, plainStyle.borderColor, plainStyle.padding, plainStyle.borderRadius];
        banner.classList.add("inlineState");
        const appearance = [style.background, style.borderColor, style.padding, style.borderRadius];
        if (JSON.stringify(appearance) !== JSON.stringify(plainAppearance)) issues.push("Inline state overrides banner appearance or spacing");
      }
      for (const side of ["Top", "Right", "Bottom", "Left"]) {
        if (Number.parseFloat(style[`padding${side}`]) < minimum) issues.push(`Banner lacks ${side.toLowerCase()} padding: ${banner.className}`);
      }
      for (const child of banner.children) {
        if (!contains(box, child.getBoundingClientRect(), minimum)) issues.push(`Banner content escapes padding: ${banner.className}`);
      }
      const icon = banner.querySelector(".uiBannerIcon").getBoundingClientRect();
      const copy = banner.querySelector(".uiBannerCopy").getBoundingClientRect();
      if (!banner.querySelector(".uiBannerMessage, .uiBannerDetails") && Math.abs(icon.top + icon.height / 2 - copy.top - copy.height / 2) > 1) {
        issues.push(`Title-only banner is not vertically centered: ${banner.className}`);
      }
      if (!banner.querySelector(".uiBannerAction") && Math.abs(box.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight) - copy.right) > 1) {
        issues.push(`Banner reserves an empty action column: ${banner.className}`);
      }
      if (banner.scrollWidth > banner.clientWidth + 1) issues.push(`Banner overflows: ${banner.className}`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push("Document overflows horizontally");
    return { icons, banners, issues: [...new Set(issues)] };
  });
  assert.deepEqual(result.issues, [], `${label}: ${result.issues.join("; ")}`);
  return result;
}

async function navigate(page, name) {
  const target = page.locator(`[data-nav-page="${name}"]`);
  await target.waitFor({ state: "attached" });
  if (!await target.isVisible()) await page.getByRole("button", { name: "Expand navigation" }).click();
  await checkSpacing(page, `${name} navigation`);
  await target.click();
  await page.locator(`.workspacePage-${name}`).waitFor();
}

try {
  for (const width of widths) {
    for (const theme of ["light", "dark"]) {
      const browser = await launchBrowser(width === 320 ? webkit : chromium);
      try {
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
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
        // Force a real workspace error banner with a long backend message and retry action.
        await page.route("**/api/app", route => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "The backend is temporarily unavailable. ".repeat(8) } } }));
        await page.reload();
        await page.locator(".inlineState-error.uiBanner").waitFor();
        await checkSpacing(page, `${label} workspace error`);
        // Reuse rendered Banner markup to exercise every tone, density, and content shape.
        await page.evaluate(() => {
          const source = document.querySelector(".inlineState-error.uiBanner");
          const gallery = document.createElement("div");
          gallery.id = "spacing-banner-fixtures";
          gallery.style.cssText = "display:grid;gap:16px;min-width:0";
          for (const tone of ["warning", "error", "info", "success"]) {
            for (const compact of [false, true]) {
              for (const titleOnly of [false, true]) {
                const banner = source.cloneNode(true);
                banner.className = `uiBanner uiBanner--${tone} ${compact ? "uiBanner--compact" : ""} ${tone === "error" ? "inlineState inlineState-error" : ""}`;
                banner.querySelector("strong").textContent = titleOnly ? "Node offline" : "UnreachableHost".repeat(12);
                if (titleOnly) {
                  banner.querySelector(".uiBannerMessage")?.remove();
                  banner.querySelector(".uiBannerAction")?.remove();
                } else {
                  banner.querySelector(".uiBannerMessage").textContent = "The connection failed. Check the host and retry. ".repeat(6);
                  const details = document.createElement("div");
                  details.className = "uiBannerDetails";
                  details.textContent = "ConnectionDetails".repeat(14);
                  banner.querySelector(".uiBannerCopy").append(details);
                }
                gallery.append(banner);
              }
            }
          }
          document.querySelector(".workspace").append(gallery);
        });
        const fixtures = await checkSpacing(page, `${label} banner variants`);
        assert(fixtures.banners >= 16, `${label}: banner variants did not render`);
        if (screenshots) await page.screenshot({ path: `${screenshots}/${label}-error.png`, fullPage: true });
        await context.close();
        console.log(`Icon and banner spacing passed: ${label}`);
      } finally { await browser.close(); }
    }
  }
} finally { await harness.stop(); }
