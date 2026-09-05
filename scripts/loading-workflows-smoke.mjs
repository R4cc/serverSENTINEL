import assert from "node:assert/strict";
import { chromium } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

// Exercise the production UI with deterministic remote reads, using only the harness-owned demo
// account. Interception leaves production data and server lifecycle operations untouched.
const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-loading-smoke-" });
let browser;
try {
  browser = await launchBrowser(chromium);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await signInThroughApi(context, harness.baseUrl);
  const headers = { "X-Requested-With": "XMLHttpRequest" };
  const session = await (await context.request.get(`${harness.baseUrl}/api/auth/session`, { headers })).json();
  const base = await (await context.request.get(`${harness.baseUrl}/api/app`, { headers })).json();
  const servers = ["Alpha", "Beta"].map((name, index) => ({
    id: `loading-${index}`, displayName: name, nodeId: "local", nodeName: "Panel Host",
    directoryLabel: `/test/${name}`, storageName: name.toLowerCase(), schedules: [],
    runtimeProfile: { minecraftVersion: "1.21.4", runtimeType: "fabric", javaMajorVersion: 21 },
    dockerContainer: name.toLowerCase(), dockerImage: "test", hasDockerContainer: true,
    javaArgs: "-Xmx2G", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }));
  const nodes = [{ id: "local", name: "Panel Host", type: "local", status: "online", isInternal: true, dockerStatus: "available", dataPathStatus: "ready" }];
  const app = { ...base, servers, nodes, currentUser: session.user, dockerSocketMounted: true };
  let storageMode = "ok", storageDelay = 0, filesDelay = 0, fileRevision = 1;
  let fileFailure = false;
  let storageRequests = 0, fileRequests = 0;
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/auth/session") return json({ ...session, demo: false });
    if (path === "/api/app") return json(app);
    if (path === "/api/nodes") return json({ nodes });
    if (path.endsWith("/storage")) {
      storageRequests++;
      const mode = storageMode, delay = storageDelay;
      await new Promise(resolve => setTimeout(resolve, delay));
      if (mode !== "ok") return json({ error: { message: "Injected storage failure" } }, mode === "denied" ? 403 : 503);
      return json({ worldSizeBytes: path.includes("loading-0") ? 1073741824 : 2147483648, totalBytes: 10737418240, availableBytes: 5368709120 });
    }
    if (path.endsWith("/files")) {
      fileRequests++;
      const revision = fileRevision;
      const failed = fileFailure;
      await new Promise(resolve => setTimeout(resolve, url.searchParams.get("path") === "/slow" ? 1200 : filesDelay));
      if (failed) return json({ error: { message: "Injected folder failure" } }, failed === "denied" ? 403 : 503);
      const folder = url.searchParams.get("path") ?? "/";
      const directories = folder === "/" ? ["slow", "fast", "empty"].map(name => ({ name, path: `/${name}`, type: "directory", size: 0, modifiedAt: new Date().toISOString() })) : [];
      return json({ path: folder, entries: folder === "/empty" ? [] : [...directories, { name: folder === "/" ? `${path.includes("loading-0") ? "alpha" : "beta"}-${revision}.txt` : `${folder.slice(1)}-result.txt`, path: `/${revision}.txt`, type: "file", size: 12, modifiedAt: new Date().toISOString() }] });
    }
    if (path.endsWith("/status")) return json({ server: servers.find(server => path.includes(server.id)), docker: { configured: true, available: true, controllable: true, running: false, state: "exited" }, lifecycle: { state: "stopped", intent: "stopped" }, fileLogsAvailable: true });
    if (path.endsWith("/events")) return json({ events: [], activity: {} });
    if (path.endsWith("/timeline")) return json({ from: Number(url.searchParams.get("from")), to: Number(url.searchParams.get("to")), generatedAt: new Date().toISOString(), samples: [], events: [], schedules: [], scheduleAnnotationsAvailable: true, truncated: { schedules: false } });
    if (path.endsWith("/mods")) return json({ mods: [] });
    if (path.endsWith("/mods/update-plan")) return json(null);
    if (path.endsWith("/console")) return json({ lines: [], cursor: 0 });
    return route.continue();
  });
  await page.goto(harness.baseUrl);
  const open = async name => {
    await page.locator(`[data-nav-page="${name}"]`).click();
    await page.locator(`.workspacePage-${name}`).waitFor();
  };

  await open("overview");
  await page.getByText("1 GiB", { exact: true }).waitFor();
  const beforeBurst = storageRequests;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(350);
  assert.equal(storageRequests - beforeBurst, 1, "reactivation burst should make one storage read");
  storageMode = "failed";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByText("Storage is not up to date", { exact: true }).waitFor();
  assert(await page.getByText("1 GiB", { exact: true }).isVisible(), "failed refresh should preserve measured data");
  storageMode = "ok";
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByText("Storage is not up to date", { exact: true }).waitFor({ state: "hidden" });
  storageDelay = 1200;
  await page.reload();
  await page.getByText("1 GiB", { exact: true }).waitFor({ timeout: 1000 });
  assert(await page.getByText("1 GiB", { exact: true }).isVisible(), "cached load should show sizes before the delayed read");
  await open("files");
  await page.getByText("alpha-1.txt", { exact: true }).waitFor();

  await open("overview");
  fileRevision = 2;
  filesDelay = 800;
  const beforeReturn = fileRequests;
  await open("files");
  assert(await page.getByText("alpha-1.txt", { exact: true }).isVisible(), "cached rows should stay visible on return");
  await page.getByText("alpha-2.txt", { exact: true }).waitFor();
  assert.equal(fileRequests - beforeReturn, 1, "return should revalidate the folder once");
  filesDelay = 0;
  await page.getByRole("rowheader", { name: "slow", exact: true }).dblclick();
  await page.getByRole("rowheader", { name: "fast", exact: true }).dblclick();
  await page.getByText("fast-result.txt", { exact: true }).waitFor();
  await page.waitForTimeout(1300);
  assert.equal(await page.getByText("slow-result.txt", { exact: true }).count(), 0, "older folder read must not win");
  await page.getByRole("button", { name: "Go to server root", exact: true }).click();
  await page.getByRole("rowheader", { name: "empty", exact: true }).dblclick();
  await page.getByText("This folder is empty", { exact: true }).waitFor();
  filesDelay = 600;
  await page.getByRole("button", { name: "Refresh files", exact: true }).click();
  assert(await page.getByText("This folder is empty", { exact: true }).isVisible());
  assert.equal(await page.locator(".fileTableSkeletonRow").count(), 0, "empty cached folders should not return to initial skeletons");
  await page.getByRole("button", { name: "Refresh files", exact: true }).waitFor();
  filesDelay = 0;
  await page.getByRole("button", { name: "Go to server root", exact: true }).click();
  await page.getByText("alpha-2.txt", { exact: true }).waitFor();
  fileFailure = true;
  await page.getByRole("button", { name: "Refresh files", exact: true }).click();
  await page.getByText("Could not load this folder", { exact: true }).waitFor();
  assert(await page.getByText("alpha-2.txt", { exact: true }).isVisible());
  fileFailure = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Could not load this folder", { exact: true }).waitFor({ state: "hidden" });
  // Leave an Alpha read pending, then move to Beta; Alpha's late result must not paint Beta.
  filesDelay = 1500;
  await page.getByRole("button", { name: "Refresh files", exact: true }).click();
  await page.getByRole("button", { name: /Switch server/ }).click();
  filesDelay = 0;
  await page.getByRole("menuitem", { name: /Beta/ }).click();
  await open("files");
  await page.getByText("beta-2.txt", { exact: true }).waitFor();
  await page.waitForTimeout(1700);
  assert.equal(await page.getByText("alpha-2.txt", { exact: true }).count(), 0);
  assert(await page.getByRole("button", { name: "Refresh files", exact: true }).isEnabled());
  fileFailure = "denied";
  await page.getByRole("button", { name: "Refresh files", exact: true }).click();
  await page.getByText("Could not load this folder", { exact: true }).waitFor();
  assert.equal(await page.getByText("beta-2.txt", { exact: true }).count(), 0, "permission denial must discard file rows");
  fileFailure = false;
  await open("overview");
  storageDelay = 0;
  await page.getByText("2 GiB", { exact: true }).waitFor();
  storageMode = "denied";
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByText("Storage is not up to date", { exact: true }).waitFor();
  assert.equal(await page.getByText("2 GiB", { exact: true }).count(), 0, "permission denial must clear cached sizes");
  storageMode = "ok";
  storageDelay = 1000;
  app.currentUser = { ...app.currentUser, id: "other-user", permissions: ["servers.view", "files.view", "console.view"] };
  // A reload with another account must not reuse Alpha's persisted measurement.
  session.user = app.currentUser;
  await page.reload();
  await page.locator(".overviewPage").waitFor();
  assert.equal(await page.getByText("1 GiB", { exact: true }).count(), 0);
  assert.deepEqual(pageErrors, []);
  console.log("Loading smoke passed: 3 reactivation events -> 1 read; cached storage before a 1200ms response; retained rows and empty states; folder/server races; failure recovery; account and permission isolation.");
} finally {
  await browser?.close();
  await harness.stop();
}
