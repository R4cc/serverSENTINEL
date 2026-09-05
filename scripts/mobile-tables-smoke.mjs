import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, webkit } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

const output = process.env.TABLE_SCREENSHOTS || join(tmpdir(), "serversentinel-mobile-tables");
await mkdir(output, { recursive: true });
const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-tables-", env: { MODRINTH_API_KEY: "demo-token" } });
try {
  for (const [engine, name, width] of [[chromium, "chromium", 390], [webkit, "webkit", 320], [chromium, "tablet-light", 720], [chromium, "desktop", 1440]]) {
    const browser = await launchBrowser(engine);
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      if (name === "tablet-light") await context.addInitScript(() => localStorage.setItem("serversentinel-theme", "light"));
      await signInThroughApi(context, harness.baseUrl);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(harness.baseUrl);
      await page.locator(".appShell").waitFor();
      for (const [section, surface] of [["mods", ".modsWorkspaceInstalled"], ["schedules", ".scheduleTableCard"], ["files", ".filesPanel"], ["overview", ".eventsPanel"], ["players", ".playerRosterCard"], ["nodes", ".nodesBoard"], ["settings", ".settingsHub"]]) {
        const nav = page.locator(`[data-nav-page="${section === "schedules" ? "schedule" : section}"]`);
        if (!await nav.isVisible()) await page.getByRole("button", { name: "Expand navigation" }).click();
        await nav.click();
        await page.locator(surface).first().waitFor();
        if (section === "mods") await page.locator(".modsWorkspaceRow:not(.modsWorkspaceSkeletonRow)").first().waitFor();
        if (section === "players") await page.locator(".playerRosterTable tbody tr").first().waitFor();
        if (section === "settings") {
          // Demo hides user administration. Expose the normal read-only view using
          // the harness's existing admin session; never create a testing account.
          await page.route("**/api/auth/session", async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, json: { ...await response.json(), demo: false } });
          });
          const sessionResponse = await context.request.get(`${harness.baseUrl}/api/auth/session`, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          const session = await sessionResponse.json();
          assert(session.user, `User fixture requires the authenticated demo user (${sessionResponse.status()})`);
          await page.route("**/api/users", (route) => route.fulfill({ json: { users: [session.user, { ...session.user, id: "layout-fixture", username: "Administrator-with-a-long-display-name" }] } }));
          await page.reload();
          await page.locator("#settings-tab-users").click();
          await page.locator(".usersTable .uiTableRow").first().waitFor();
          await page.getByTitle("Sort by User", { exact: true }).click();
          assert.equal(await page.locator(".usersTable thead th").first().getAttribute("aria-sort"), "descending");
          await page.getByRole("button", { name: "Actions for demo", exact: true }).click();
          await page.getByRole("menuitem", { name: "Reset password", exact: true }).waitFor();
          await page.keyboard.press("Escape");
        }
        if (section === "overview") {
          const table = page.getByRole("table", { name: "Server events", exact: true });
          assert.equal(await table.getByRole("columnheader").count(), 4);
          await table.getByTitle("Sort by Event", { exact: true }).click();
          assert.equal(await table.locator("thead th").first().getAttribute("aria-sort"), "ascending");
          const pager = page.getByRole("navigation", { name: "events pagination" });
          const next = pager.getByRole("button", { name: "Next", exact: true });
          if (await next.isEnabled()) {
            await next.click();
            assert.match(await pager.innerText(), /Page 2 of/);
            await pager.getByRole("button", { name: "Previous", exact: true }).click();
          } else {
            assert.match(await pager.innerText(), /Page 1 of 1/);
          }
        }
        if (width <= 720) {
          const tableSurface = section === "settings" ? ".usersSettings" : surface;
          const clipped = await page.locator(`${tableSurface} input, ${tableSurface} button, ${tableSurface} table`).evaluateAll((elements) => elements.filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && (rect.left < 0 || rect.right > innerWidth + 1);
          }).map((element) => ({ className: element.className, text: element.textContent, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })));
          assert.deepEqual(clipped, [], `${name} ${section}: clipped table controls`);
          if (section === "mods") {
            const overlap = await page.locator(".modsWorkspaceRow:not(.modsWorkspaceSkeletonRow)").evaluateAll((rows) => rows.some((row) => {
              const status = row.querySelector(".modsWorkspaceStatus").getBoundingClientRect();
              const version = row.querySelector(".modsWorkspaceVersion").getBoundingClientRect();
              const identity = row.querySelector(".modsWorkspaceIdentity").getBoundingClientRect();
              return status.bottom > version.top || identity.bottom > status.top;
            }));
            assert(!overlap, `${name}: mod identity, status, and version overlap`);
          }
        }
        await page.locator(surface).first().evaluate((element) => element.scrollIntoView({ block: "start" }));
        await page.screenshot({ path: join(output, `${name}-${section}.png`) });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        assert(!overflow, `${name} ${section}: document overflow`);
        if (section === "mods" && width <= 720) {
          // Stress the real row's layout without changing demo or server data.
          const row = page.locator(".modsWorkspaceRow").filter({ has: page.locator(".modsUpdateAction") }).first();
          await row.evaluate((element) => {
            element.querySelector(".modsWorkspaceIdentity strong").textContent = "A very long mod name with compatibility extensions";
            element.querySelector(".modsWorkspaceVersion").textContent = "1.21.4-fabric-build.1234567890";
            element.querySelector(".modsUpdateTransition strong").textContent = "1.21.5-fabric-build.9876543210";
          });
          const clipping = await row.locator("strong, .modsWorkspaceVersion, .modsUpdateAction").evaluateAll((elements) => elements.some((element) => element.scrollWidth > element.clientWidth + 1));
          assert(!clipping, `${name}: long mod names or versions are clipped`);
          await row.scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(output, `${name}-mods-long.png`) });
        }
      }
      assert.deepEqual(errors, [], `${name}: browser errors`);
      console.log(`${name} (${width}px): table pages fit the viewport`);
      await context.close();
    } finally { await browser.close(); }
  }
  console.log(`Screenshots: ${output}`);
} finally { await harness.stop(); }
