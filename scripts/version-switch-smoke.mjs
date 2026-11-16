import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

// Drives Settings > Switch version in the real app against browser-local fixtures: the version
// choice, the review overview with a disabled mod and a new dependency, and the result overview.
// No server is mutated; the switch endpoints are answered here.
const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-version-switch-" });
const screenshotDirectory = process.env.VERSION_SWITCH_SCREENSHOTS;
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });

const plan = {
  serverId: "switch-fixture",
  generatedAt: new Date().toISOString(),
  runtimeType: "fabric",
  current: { minecraftVersion: "1.21.1", runtimeVersion: "0.16.0", dockerImage: "eclipse-temurin:21-jre" },
  target: { minecraftVersion: "1.21.4", runtimeVersion: "0.16.14", dockerImage: "eclipse-temurin:21-jre" },
  direction: "upgrade",
  contentKind: "mods",
  content: [
    { filename: "lithium-0.12.jar", displayName: "Lithium", projectId: "lithium", enabled: true, action: "disable", currentVersion: "0.12.0", reason: "No Fabric version for Minecraft 1.21.4 is published on Modrinth." },
    { filename: "cloth-config-15.0.0.jar", displayName: "Cloth Config API", projectId: "cloth-config", enabled: true, action: "install", targetVersion: "15.0.140", reason: "Newly required for Minecraft 1.21.4.", requiredBy: ["Mod Menu"] },
    { filename: "modmenu-11.0.0.jar", displayName: "Mod Menu", projectId: "modmenu", enabled: true, action: "update", currentVersion: "11.0.0", targetVersion: "13.0.0-a-very-long-version-label+1.21.4", targetVersionId: "mm13", reason: "Version 13.0.0 supports Minecraft 1.21.4." },
    { filename: "fabric-api.jar", displayName: "Fabric API", projectId: "fabric-api", enabled: true, action: "keep", currentVersion: "0.110.0", targetVersion: "0.110.0", reason: "The installed version already supports Minecraft 1.21.4." }
  ],
  counts: { keep: 1, update: 1, install: 1, disable: 1, unchanged: 0 },
  warnings: ["Once the world is opened in 1.21.4 it cannot be opened in 1.21.1 again. Back up the world first."]
};
const outcomes = [
  { filename: "lithium-0.12.jar", displayName: "Lithium", plannedAction: "disable", status: "disabled", finalFilename: "lithium-0.12.jar.disabled", reason: plan.content[0].reason },
  { filename: "cloth-config-15.0.0.jar", displayName: "Cloth Config API", plannedAction: "install", status: "installed", version: "15.0.140" },
  { filename: "modmenu-11.0.0.jar", displayName: "Mod Menu", plannedAction: "update", status: "updated", version: "13.0.0" },
  { filename: "fabric-api.jar", displayName: "Fabric API", plannedAction: "keep", status: "kept", version: "0.110.0" }
];

async function checkGeometry(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Document overflows");
  const dialog = page.locator(".versionSwitchModal");
  if (await dialog.count()) {
    assert(await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= -1 && box.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
    }), "Version switch dialog overflows the viewport");
    for (const row of await page.locator(".versionSwitchRow").all()) {
      assert(await row.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "A version switch row overflows");
    }
  }
}

async function capture(page, name) {
  await checkGeometry(page);
  if (screenshotDirectory) await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, animations: "disabled" });
}

const browser = await launchBrowser(chromium);
try {
  for (const [width, theme] of [[1440, "dark"], [1024, "light"], [390, "dark"], [320, "light"]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript((theme) => {
      localStorage.setItem("serversentinel-theme", theme);
      localStorage.setItem("serversentinel-active-page", JSON.stringify({ value: "properties", savedAt: Date.now() }));
      localStorage.setItem("serversentinel-active-server", JSON.stringify({ value: "switch-fixture", savedAt: Date.now() }));
    }, theme);
    await signInThroughApi(context, harness.baseUrl);
    const headers = { "X-Requested-With": "XMLHttpRequest" };
    const session = await (await context.request.get(`${harness.baseUrl}/api/auth/session`, { headers })).json();
    const base = await (await context.request.get(`${harness.baseUrl}/api/app`, { headers })).json();
    const now = new Date().toISOString();
    const server = {
      id: "switch-fixture", displayName: "Survival", nodeId: "local", nodeName: "Panel Host",
      directoryLabel: "/test/survival", storageName: "survival", schedules: [],
      runtimeProfile: { minecraftVersion: "1.21.1", runtimeType: "fabric", runtimeVersion: "0.16.0", javaMajorVersion: 21, jarProvider: "mcjars", jarArtifact: { filename: "fabric-server-launch.jar" }, compatibilityStatus: "compatible" },
      dockerContainer: "survival", dockerImage: "eclipse-temurin:21-jre", hasDockerContainer: true,
      dockerPorts: "25565:25565/tcp,25566:25566/udp", javaArgs: "-Xms2G -Xmx4G", startOnNodeStart: false, createdAt: now, updatedAt: now
    };
    const nodes = [{ id: "local", name: "Panel Host", type: "local", status: "online", isInternal: true, dockerStatus: "available", dataPathStatus: "ready", totalMemory: 32 * 1024 ** 3 }];
    const requests = { plan: [], apply: [] };
    let releaseApply;
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body, status = 200) => route.fulfill({ status, json: body });
      if (path === "/api/auth/session") return json({ ...session, demo: false });
      if (path === "/api/app") return json({ ...base, servers: [server], nodes, currentUser: session.user, dockerSocketMounted: true });
      if (path === "/api/nodes") return json({ nodes });
      if (path.endsWith("/status")) return json({ server, docker: { configured: true, available: true, controllable: true, running: false, state: "exited" }, lifecycle: { state: "stopped", intent: "stopped" }, fileLogsAvailable: true });
      if (path.endsWith("/exports")) return json({ latest: null, artifact: null });
      if (path.endsWith("/events")) return json({ events: [], activity: {} });
      if (path.endsWith("/storage")) return json({ worldSizeBytes: 1, totalBytes: 100, availableBytes: 80 });
      if (path === "/api/runtime/fabric/minecraft-versions") {
        return json({ versions: ["1.21.4", "1.21.3", "1.21.1", "1.20.6"].map((id) => ({ id, type: "release", supported: true })) });
      }
      if (path === "/api/runtime/fabric/versions") return json({ runtimeVersions: [{ id: "0.16.14", runtimeVersion: "0.16.14", stable: true }, { id: "0.16.10", runtimeVersion: "0.16.10", stable: true }] });
      if (path === `/api/servers/${server.id}/version-switch/plan`) {
        const body = route.request().postDataJSON();
        requests.plan.push(body);
        if (body.minecraftVersion === "1.20.6") return json({ ...plan, direction: "downgrade", target: { ...plan.target, minecraftVersion: "1.20.6" }, warnings: ["Minecraft does not support opening a world in an older version. Back up the world first."] });
        return json(plan);
      }
      if (path === `/api/servers/${server.id}/version-switch`) {
        requests.apply.push(route.request().postDataJSON());
        await new Promise((resolve) => { releaseApply = resolve; });
        server.runtimeProfile = { ...server.runtimeProfile, minecraftVersion: "1.21.4", runtimeVersion: "0.16.14" };
        server.updatedAt = new Date().toISOString();
        return json({ plan, outcomes, counts: { kept: 1, updated: 1, installed: 1, disabled: 1, unchanged: 0, failed: 0 }, server });
      }
      assert.equal(route.request().method(), "GET", `Unexpected mutation: ${path}`);
      return route.continue();
    });
    try {
      await page.goto(harness.baseUrl);
      const switchButton = page.getByRole("button", { name: "Switch version", exact: true });
      await switchButton.waitFor();
      await page.waitForFunction(() => !document.querySelector("#properties-display-name")?.disabled);
      assert.equal(await page.locator("#properties-minecraft-version").getAttribute("readonly"), "", "Minecraft version is editable inline");

      // Unsaved settings would be discarded by the switch, so the button waits for them.
      await page.locator("#properties-display-name").fill("Survival edited");
      assert(await switchButton.isDisabled(), "Switch version is offered over unsaved changes");
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await page.locator(".propertiesSaveDock").waitFor({ state: "detached" });
      assert(await switchButton.isEnabled());

      await switchButton.click();
      const dialog = page.getByRole("dialog", { name: "Switch Minecraft version" });
      await dialog.waitFor();
      const minecraft = dialog.getByLabel("Minecraft version", { exact: true });
      await page.waitForFunction(() => document.querySelectorAll(".versionSwitchModal select option").length > 1);
      assert.equal(await minecraft.inputValue(), "1.21.4", "The newest other release is not preselected");
      assert.match(await dialog.innerText(), /Currently 1\.21\.1/);
      await capture(page, `${width}-${theme}-choose`);

      // Choosing the current version and loader is not a switch.
      await minecraft.selectOption("1.21.1");
      assert(await dialog.getByRole("button", { name: "Review changes", exact: true }).isDisabled());

      // A downgrade asks for a backup before it can run.
      await minecraft.selectOption("1.20.6");
      await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
      const downgrade = dialog.getByRole("button", { name: "Switch to 1.20.6", exact: true });
      await downgrade.waitFor();
      assert(await downgrade.isDisabled(), "A downgrade runs without a backup confirmation");
      await dialog.getByText("I have a backup of this server's world.", { exact: true }).click();
      assert(await downgrade.isEnabled());
      await dialog.getByRole("button", { name: "Back", exact: true }).click();

      await minecraft.selectOption("1.21.4");
      await dialog.getByLabel("Fabric Loader version", { exact: true }).selectOption("0.16.14");
      await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
      await dialog.getByText("Will be disabled", { exact: true }).waitFor();
      assert.deepEqual(requests.plan.at(-1), { minecraftVersion: "1.21.4", runtimeVersion: "0.16.14" });
      const review = await dialog.innerText();
      for (const text of ["Lithium", "No Fabric version for Minecraft 1.21.4", "New dependencies", "Required by Mod Menu.", "Will switch version", "1 mod switches version · 1 dependency added · 1 mod disabled · 1 already compatible."]) {
        assert(review.includes(text), `Review is missing "${text}"`);
      }
      // Kept mods are tucked away so the overview opens on what changes.
      assert.equal(await dialog.locator("details.versionSwitchGroup").getAttribute("open"), null);
      await capture(page, `${width}-${theme}-review`);

      await dialog.getByRole("button", { name: "Switch to 1.21.4", exact: true }).click();
      await dialog.getByRole("button", { name: "Switching…", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      assert(await dialog.isVisible(), "The dialog closes while the switch is running");
      await capture(page, `${width}-${theme}-applying`);
      releaseApply();

      const done = page.getByRole("dialog", { name: "Switched to Minecraft 1.21.4" });
      await done.getByText("1 mod needs attention", { exact: true }).waitFor();
      assert.deepEqual(requests.apply, [{ minecraftVersion: "1.21.4", runtimeVersion: "0.16.14" }]);
      const result = await done.innerText();
      for (const text of ["Disabled", "Lithium", "Installed", "Cloth Config API", "Switched version", "Mod Menu"]) {
        assert(result.includes(text), `Result is missing "${text}"`);
      }
      await capture(page, `${width}-${theme}-done`);
      await done.getByRole("button", { name: "Done", exact: true }).click();
      await done.waitFor({ state: "detached" });
      await page.waitForFunction(() => document.querySelector("#properties-minecraft-version")?.value === "1.21.4");
      assert.deepEqual(errors, []);
      console.log(`Version switch passed: ${width}px ${theme}`);
    } catch (error) {
      console.error(errors);
      throw error;
    } finally {
      releaseApply?.();
      await context.close();
    }
  }
} finally {
  await browser.close();
  await harness.stop();
}
