import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-properties-ui-" });
const screenshotDirectory = process.env.PROPERTIES_SCREENSHOTS;
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });

async function checkGeometry(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Document overflows");
  for (const selector of [".propertiesSettingsSurface", ".propertiesMaintenance", ".propertiesSaveDock"]) {
    for (const element of await page.locator(selector).all()) {
      assert(await element.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${selector} overflows`);
    }
  }
  const dock = page.locator(".propertiesSaveDock");
  if (await dock.count()) {
    assert(await dock.evaluate(element => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    }), "Save controls leave the viewport");
  }
}

async function capture(page, name) {
  await checkGeometry(page);
  if (screenshotDirectory) await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, fullPage: true, animations: "disabled" });
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
        localStorage.setItem("serversentinel-active-page", JSON.stringify({ value: "properties", savedAt: Date.now() }));
        localStorage.setItem("serversentinel-active-server", JSON.stringify({ value: "properties-fixture", savedAt: Date.now() }));
      }, theme);
      await signInThroughApi(context, harness.baseUrl);
      const headers = { "X-Requested-With": "XMLHttpRequest" };
      const session = await (await context.request.get(`${harness.baseUrl}/api/auth/session`, { headers })).json();
      const base = await (await context.request.get(`${harness.baseUrl}/api/app`, { headers })).json();
      const now = new Date().toISOString();
      const server = {
        id: "properties-fixture", displayName: "Survival", nodeId: "local", nodeName: "Panel Host",
        directoryLabel: "/test/survival", storageName: "survival", schedules: [],
        runtimeProfile: { minecraftVersion: "1.21.4", runtimeType: "fabric", runtimeVersion: "0.16.10", javaMajorVersion: 21, jarProvider: "mcjars", jarArtifact: { filename: "fabric-server-launch.jar" }, compatibilityStatus: "compatible" },
        dockerContainer: "survival", dockerImage: "eclipse-temurin:21-jre", hasDockerContainer: true,
        dockerPorts: "25565:25565/tcp,25566:25566/udp,8123:8123/tcp", javaArgs: "-Xms2G -Xmx4G -XX:+UseG1GC",
        startOnNodeStart: false, createdAt: now, updatedAt: now
      };
      const nodes = [{ id: "local", name: "Panel Host", type: "local", status: "online", isInternal: true, dockerStatus: "available", dataPathStatus: "ready", totalMemory: 32 * 1024 ** 3 }];
      let running = false;
      let exportState = { latest: null, artifact: null };
      let pendingSave;
      let submitted;
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      // Exercise the real app form against browser-local fixtures; no server is mutated.
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        const json = body => route.fulfill({ json: body });
        if (path === "/api/auth/session") return json({ ...session, demo: false });
        if (path === "/api/app") return json({ ...base, servers: [server], nodes, currentUser: session.user, dockerSocketMounted: true });
        if (path === "/api/nodes") return json({ nodes });
        if (path.endsWith("/status")) return json({ server, docker: { configured: true, available: true, controllable: true, running, state: running ? "running" : "exited" }, lifecycle: { state: running ? "running" : "stopped", intent: running ? "running" : "stopped" }, fileLogsAvailable: true });
        if (path.endsWith("/exports")) return json(exportState);
        if (path.endsWith("/events")) return json({ events: [], activity: {} });
        if (path.endsWith("/storage")) return json({ worldSizeBytes: 1, totalBytes: 100, availableBytes: 80 });
        if (path === "/api/runtime/fabric/minecraft-versions") return json({ versions: [{ id: "1.21.4", type: "release", supported: true }] });
        if (path === "/api/runtime/fabric/versions") return json({ runtimeVersions: [{ runtimeVersion: "0.16.10", stable: true }] });
        if (path === `/api/servers/${server.id}` && route.request().method() === "PUT") {
          submitted = route.request().postDataJSON();
          await new Promise(resolve => { pendingSave = resolve; });
          Object.assign(server, { displayName: submitted.displayName, javaArgs: submitted.javaArgs, dockerPorts: submitted.dockerPorts, startOnNodeStart: submitted.startOnNodeStart, updatedAt: new Date().toISOString() });
          return json(server);
        }
        assert.equal(route.request().method(), "GET", `Unexpected mutation: ${path}`);
        return route.continue();
      });
      try {
        await page.goto(harness.baseUrl);
        const form = page.locator(".serverPropertiesForm");
        const name = page.locator("#properties-display-name");
        await name.waitFor();
        await page.waitForFunction(() => !document.querySelector("#properties-display-name")?.disabled);
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator(".propertiesSaveDock").count(), 0);
        const deletion = page.locator(".propertiesDeleteDisclosure");
        assert.equal(await deletion.getAttribute("open"), null);
        assert.equal(await page.getByLabel("Type server name to confirm", { exact: true }).isVisible(), false);
        await capture(page, `${width}-${theme}-idle`);

        const minimum = page.locator("#edit-minimum-heap");
        const maximum = page.locator("#edit-maximum-heap");
        await maximum.fill("6");
        await minimum.fill("3");
        await page.locator(".propertiesDisclosure > summary").click();
        assert.match(await page.locator("#edit-java-args").inputValue(), /-Xms3G -Xmx6G -XX:\+UseG1GC/);
        await page.locator("#properties-query-port").fill("25565");
        assert(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled(), "Conflicting ports can be saved");
        await page.getByText("Server port and Query port must be different.", { exact: true }).waitFor();
        await capture(page, `${width}-${theme}-invalid`);
        await page.getByRole("button", { name: "Discard", exact: true }).click();
        await page.locator(".propertiesSaveDock").waitFor({ state: "detached" });
        assert.equal(await minimum.inputValue(), "2");
        assert.equal(await maximum.inputValue(), "4");
        assert.equal(await page.locator("#properties-query-port").inputValue(), "25566");

        await name.fill("Survival Updated");
        await page.locator(".propertiesStartupToggle").click();
        assert(await page.getByLabel("Start when node starts", { exact: true }).isChecked());
        await maximum.fill("6");
        await page.getByRole("button", { name: "Add port binding", exact: true }).click();
        await page.getByLabel("Additional host port", { exact: true }).last().fill("24454");
        await page.getByLabel("Additional container port and protocol", { exact: true }).last().fill("24454/udp");
        await capture(page, `${width}-${theme}-edited`);
        await page.getByRole("button", { name: "Save changes", exact: true }).click();
        await page.getByRole("button", { name: "Saving changes", exact: true }).waitFor();
        assert(await name.isDisabled(), "Form accepts edits while saving");
        assert(await page.getByRole("button", { name: "Discard", exact: true }).isDisabled());
        await capture(page, `${width}-${theme}-saving`);
        assert.equal(submitted.displayName, "Survival Updated");
        assert.equal(submitted.startOnNodeStart, true);
        assert.match(submitted.javaArgs, /-Xms2G -Xmx6G -XX:\+UseG1GC/);
        assert.match(submitted.dockerPorts, /24454:24454\/udp/);
        assert.equal(submitted.runtime.serverJar, "fabric-server-launch.jar");
        pendingSave();
        await page.locator(".propertiesSaveDock").waitFor({ state: "detached" });

        const summary = deletion.locator("summary");
        await summary.focus();
        await page.keyboard.press("Enter");
        const confirmation = page.getByLabel("Type server name to confirm", { exact: true });
        await confirmation.waitFor();
        const remove = deletion.getByRole("button", { name: "Delete server", exact: true });
        await confirmation.fill("Survival");
        assert(await remove.isDisabled(), "Deletion accepts the old name");
        await confirmation.fill("Survival Updated");
        assert(await remove.isEnabled(), "Exact-name confirmation cannot enable deletion");
        await capture(page, `${width}-${theme}-delete`);
        await summary.click();
        assert.equal(await confirmation.isVisible(), false);
        assert.equal(await form.locator("form").count(), 0, "Maintenance form is nested in settings");

        running = true;
        await page.reload();
        await page.getByText("Stop the server before changing mods, plugins, or server properties.", { exact: true }).waitFor();
        assert(await name.isDisabled(), "Running server configuration is editable");
        await page.locator(".propertiesDisclosure > summary").click();
        assert(await page.locator("#edit-java-args").isVisible());
        assert(await page.locator("#edit-java-args").isDisabled());
        await deletion.locator("summary").click();
        assert(await confirmation.isDisabled(), "Running server deletion accepts confirmation");
        await capture(page, `${width}-${theme}-locked`);

        running = false;
        exportState = {
          latest: { id: "export-current", status: "running", progress: 42, task: "Archiving server files", createdAt: now, startedAt: now, canCancel: true, startedByRequester: true },
          artifact: { operationId: "export-previous", filename: "Survival-with-a-long-retained-export-name-2026-10-04.zip", size: 123456789, createdAt: now, downloadUrl: "/api/exports/export-previous/download" }
        };
        await page.reload();
        await page.getByRole("progressbar", { name: "Export progress" }).waitFor();
        assert(await page.getByRole("button", { name: "New export", exact: true }).isDisabled());
        assert(await page.getByRole("button", { name: "Abort", exact: true }).isEnabled());
        assert(await page.getByRole("link", { name: "Download", exact: true }).isVisible());
        await capture(page, `${width}-${theme}-exporting`);
        exportState.latest = { ...exportState.latest, status: "succeeded", progress: 100, task: "Export complete", finishedAt: now, canCancel: false };
        exportState.artifact = { ...exportState.artifact, operationId: "export-current" };
        await page.reload();
        await page.getByText("Export complete", { exact: true }).waitFor();
        assert(await page.getByRole("button", { name: "New export", exact: true }).isEnabled());
        assert.equal(await page.getByRole("button", { name: "Abort", exact: true }).count(), 0);
        await capture(page, `${width}-${theme}-export-ready`);
        assert.deepEqual(errors, []);
        console.log(`Properties UI passed: ${width}px ${theme}`);
      } catch (error) {
        console.error(await page.locator("body").innerText());
        console.error(errors);
        throw error;
      } finally {
        pendingSave?.();
        await context.close();
      }
    } finally { await browser.close(); }
  }
} finally { await harness.stop(); }
