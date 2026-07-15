import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = await mkdtemp(join(tmpdir(), "serversentinel-mobile-smoke-"));
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const installCommand = "npx playwright install chromium webkit";

let server;
let serverOutput = "";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const listener = createServer();
    listener.once("error", rejectPort);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const selectedPort = typeof address === "object" && address ? address.port : 0;
      listener.close((error) => error ? rejectPort(error) : resolvePort(selectedPort));
    });
  });
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Demo server stopped before it became ready.\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/session`, { headers: { "X-Requested-With": "XMLHttpRequest" } });
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for the demo server at ${baseUrl}.\n${serverOutput}`);
}

async function signIn(page) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username").fill("demo");
  await page.getByLabel("Password").fill("demo");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  try {
    await page.locator(".appShell").waitFor({ timeout: 15_000 });
  } catch {
    const notice = await page.locator(".notice").textContent().catch(() => "");
    throw new Error(`Demo startup is broken: demo / demo could not sign in.${notice ? ` ${notice.trim()}` : ""}`);
  }
}

async function openPage(page, title) {
  const target = page.locator(`.sideNav button[title="Open ${title}"]`);
  if (!await target.isVisible()) await page.getByRole("button", { name: "Expand navigation" }).click();
  await target.click();
  await page.locator(`.workspacePage-${title === "schedules" ? "schedule" : title}`).waitFor();
}

async function shellMetrics(page) {
  return page.evaluate(() => {
    const shell = document.querySelector(".appShell");
    const workspace = document.querySelector(".workspace");
    if (!(shell instanceof HTMLElement) || !(workspace instanceof HTMLElement)) throw new Error("App shell is unavailable");
    const workspaceRect = workspace.getBoundingClientRect();
    return {
      documentTop: document.documentElement.scrollTop,
      bodyTop: document.body.scrollTop,
      shellTop: shell.scrollTop,
      shellOverflow: getComputedStyle(shell).overflow,
      rootOverflow: getComputedStyle(document.documentElement).overflow,
      shellHeight: shell.getBoundingClientRect().height,
      viewportVariable: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--visual-viewport-height")),
      workspace: { x: workspaceRect.x, y: workspaceRect.y, width: workspaceRect.width, height: workspaceRect.height }
    };
  });
}

function assertStableShell(metrics, label) {
  assert(metrics.documentTop === 0 && metrics.bodyTop === 0 && metrics.shellTop === 0, `${label}: document or shell scrolled independently`);
  assert(metrics.shellOverflow === "hidden" && metrics.rootOverflow === "hidden", `${label}: outer scroll containers are not frozen`);
  assert(Math.abs(metrics.shellHeight - metrics.viewportVariable) <= 1, `${label}: shell is not synchronized to the visual viewport`);
}

async function assertNavigationOverlay(page, label) {
  const before = await shellMetrics(page);
  await page.getByRole("button", { name: "Expand navigation" }).click();
  await page.locator(".mobileNavigationOpen").waitFor();
  const open = await shellMetrics(page);
  for (const key of ["x", "y", "width", "height"]) {
    assert(Math.abs(before.workspace[key] - open.workspace[key]) <= 1, `${label}: opening navigation changed workspace ${key} (${before.workspace[key]} -> ${open.workspace[key]})`);
  }
  assertStableShell(open, `${label} navigation open`);
  await page.keyboard.press("Escape");
  await page.locator(".mobileNavigationOpen").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Expand navigation", null, { timeout: 2_000 });
}

async function assertEditableFontSizes(page, label) {
  const undersized = await page.evaluate(() => Array.from(document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]), select, textarea, [contenteditable="true"]'))
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    })
    .map((element) => ({ element: element.outerHTML.slice(0, 120), size: Number.parseFloat(getComputedStyle(element).fontSize) }))
    .filter(({ size }) => size < 16));
  assert(undersized.length === 0, `${label}: editable controls below 16px: ${JSON.stringify(undersized)}`);
}

async function assertTargets(page, selectors, label) {
  const failures = await page.evaluate((candidateSelectors) => candidateSelectors.flatMap((selector) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) return [{ selector, missing: true }];
    const rect = element.getBoundingClientRect();
    return rect.width < 44 || rect.height < 44 ? [{ selector, width: rect.width, height: rect.height }] : [];
  }), selectors);
  assert(failures.length === 0, `${label}: mobile targets are smaller than 44px: ${JSON.stringify(failures)}`);
}

async function assertFloatingSurfaces(page, label) {
  const badge = page.locator(".restartRequirementBadge");
  if (await badge.count()) {
    await badge.focus();
    const tooltip = await page.locator(".restartRequirementTooltip").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
    });
    assert(tooltip.left >= 0 && tooltip.right <= tooltip.width && tooltip.top >= 0 && tooltip.bottom <= tooltip.height, `${label}: restart tooltip leaves the viewport: ${JSON.stringify(tooltip)}`);
  }

  await page.getByRole("button", { name: "More server actions" }).click();
  const menu = await page.locator(".overflowDropdown").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
  });
  assert(menu.left >= 0 && menu.right <= menu.width && menu.top >= 0 && menu.bottom <= menu.height, `${label}: server action menu leaves the viewport: ${JSON.stringify(menu)}`);
  await page.keyboard.press("Escape");
}

async function assertPageScrollOwner(page, title, ownerSelector, label) {
  await openPage(page, title);
  await page.locator(ownerSelector).waitFor({ timeout: 10_000 });
  const result = await page.evaluate((selector) => {
    const shell = document.querySelector(".appShell");
    const workspace = document.querySelector(".workspace");
    const owner = document.querySelector(selector);
    if (!(shell instanceof HTMLElement) || !(workspace instanceof HTMLElement) || !(owner instanceof HTMLElement)) return { missing: true };
    const overflow = getComputedStyle(owner).overflowY;
    const before = owner.scrollTop;
    if (owner.scrollHeight > owner.clientHeight) owner.scrollTop = Math.min(80, owner.scrollHeight - owner.clientHeight);
    const moved = owner.scrollTop > before;
    owner.scrollTop = before;
    return {
      missing: false,
      overflow,
      canOverflow: owner.scrollHeight > owner.clientHeight,
      moved,
      outerTops: [document.documentElement.scrollTop, document.body.scrollTop, shell.scrollTop],
      workspaceOverflow: getComputedStyle(workspace).overflowY
    };
  }, ownerSelector);
  assert(!result.missing, `${label}: intended scroll owner ${ownerSelector} is missing`);
  assert(["auto", "scroll"].includes(result.overflow), `${label}: ${ownerSelector} is not scrollable (${result.overflow})`);
  assert(!result.canOverflow || result.moved, `${label}: ${ownerSelector} cannot reach overflowing content`);
  assert(result.outerTops.every((value) => value === 0), `${label}: an outer scroll surface moved`);
}

async function assertDialogScrollLock(page, backdropSelector, dialogBodySelector, backgroundSelector, label) {
  const result = await page.evaluate(({ backdropSelector: backdrop, dialogBodySelector: body, backgroundSelector: background }) => {
    const backdropElement = document.querySelector(backdrop);
    const bodyElement = document.querySelector(body);
    const backgroundElement = document.querySelector(background);
    if (!(backdropElement instanceof HTMLElement) || !(bodyElement instanceof HTMLElement) || !(backgroundElement instanceof HTMLElement)) return { missing: true };
    backgroundElement.scrollTop = Math.min(30, Math.max(0, backgroundElement.scrollHeight - backgroundElement.clientHeight));
    const before = backgroundElement.scrollTop;
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 240 });
    backdropElement.dispatchEvent(event);
    bodyElement.scrollTop = Math.min(80, Math.max(0, bodyElement.scrollHeight - bodyElement.clientHeight));
    return {
      missing: false,
      prevented: event.defaultPrevented,
      before,
      after: backgroundElement.scrollTop,
      bodyOverflow: getComputedStyle(bodyElement).overflowY,
      bodyCanOverflow: bodyElement.scrollHeight > bodyElement.clientHeight,
      bodyTop: bodyElement.scrollTop
    };
  }, { backdropSelector, dialogBodySelector, backgroundSelector });
  assert(!result.missing, `${label}: dialog scroll surfaces are missing`);
  assert(result.prevented, `${label}: outside wheel input was not blocked`);
  assert(result.before === result.after, `${label}: background scroll position changed under the dialog`);
  assert(["auto", "scroll"].includes(result.bodyOverflow), `${label}: dialog content is not internally scrollable`);
  assert(!result.bodyCanOverflow || result.bodyTop > 0, `${label}: dialog content cannot be scrolled`);
}

async function runProfile(engine, profile, label) {
  let browser;
  try {
    try {
      browser = await engine.launch({ headless: true });
    } catch (error) {
      if (/executable doesn.t exist|browser.*not found|please run/i.test(String(error))) {
        throw new Error(`Playwright browser binaries are missing. Run: ${installCommand}\n${error}`);
      }
      throw error;
    }

    const context = await browser.newContext({
      ...profile,
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "reduce"
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("serversentinel-theme", "light");
      localStorage.setItem("serversentinel-active-page", "overview");
    });
    await signIn(page);

    assertStableShell(await shellMetrics(page), `${label} initial`);
    await assertNavigationOverlay(page, label);
    await assertTargets(page, [".brandBlock .iconButton", ".activeServerStrip .runtimeControlButton", ".activeServerStrip .overflowButton"], label);
    await assertFloatingSurfaces(page, label);

    const serverPageOwners = {
      overview: ".workspace > .tabPage",
      files: ".workspace .filesPage .fileTable",
      mods: ".workspace > .tabPage",
      schedules: ".workspace > .tabPage",
      console: ".workspace .xterm-viewport",
      properties: ".workspace > .tabPage"
    };
    for (const [title, owner] of Object.entries(serverPageOwners)) await assertPageScrollOwner(page, title, owner, `${label} ${title}`);
    await assertPageScrollOwner(page, "nodes", ".workspace", `${label} nodes`);
    await assertPageScrollOwner(page, "settings", ".workspace", `${label} settings`);
    await assertEditableFontSizes(page, `${label} settings`);

    await openPage(page, "files");
    await assertTargets(page, [".fileNavButtons .uiButton", ".fileToolbar .uiButton", ".fileTableRow"], `${label} files`);

    await openPage(page, "mods");
    const addMods = page.getByRole("button", { name: "Add mods", exact: true });
    assert(await addMods.isEnabled(), `${label}: demo Add mods action is unexpectedly disabled`);
    await addMods.click();
    await page.getByRole("dialog", { name: "Add mods", exact: true }).waitFor();
    await assertEditableFontSizes(page, `${label} mods drawer`);
    await assertTargets(page, [".modsDrawerHeader button"], `${label} mods drawer`);
    await assertDialogScrollLock(page, ".modsDrawerBackdrop", ".modsDrawerBody", ".workspace > .tabPage", `${label} mods drawer`);
    await page.getByRole("button", { name: "Close add mods" }).click();

    await openPage(page, "schedules");
    const scheduleTrigger = page.getByRole("button", { name: "Add schedule", exact: true });
    await scheduleTrigger.click();
    await page.getByRole("dialog").waitFor();
    await assertEditableFontSizes(page, `${label} schedule dialog`);
    await assertTargets(page, [".scheduleModalPanel .modalCloseButton"], `${label} schedule dialog`);
    await assertDialogScrollLock(page, ".scheduleModalBackdrop", ".scheduleModalPanel .scheduleEditBody", ".workspace > .tabPage", `${label} schedule dialog`);
    await page.keyboard.press("Escape");
    await page.locator(".scheduleModalPanel").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Add schedule", null, { timeout: 2_000 });

    await openPage(page, "console");
    await page.locator(".xterm-helper-textarea").waitFor({ state: "attached" });
    const terminalHelper = await page.locator(".xterm-helper-textarea").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, minHeight: getComputedStyle(element).minHeight, fontSize: getComputedStyle(element).fontSize };
    });
    assert(terminalHelper.height <= 1 && terminalHelper.width <= 1, `${label}: xterm helper inherited visible textarea geometry: ${JSON.stringify(terminalHelper)}`);
    assert(Number.parseFloat(terminalHelper.fontSize) >= 16, `${label}: xterm helper input is below 16px`);

    const initialHeight = profile.viewport.height;
    await page.setViewportSize({ width: profile.viewport.width, height: initialHeight - 80 });
    await page.waitForTimeout(100);
    assertStableShell(await shellMetrics(page), `${label} resized visual viewport`);

    await context.close();
    console.log(`mobile smoke passed: ${label}`);
  } finally {
    if (browser) await browser.close();
  }
}

try {
  server = spawn(process.execPath, [join(repositoryRoot, "server", "dist", "index.js")], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      LOG_LEVEL: "warn",
      MODRINTH_API_KEY: "demo-token",
      PORT: String(port),
      SERVERSENTINEL_DATA_DIR: dataDirectory,
      SERVERSENTINEL_ENABLE_DEMO: "true",
      SS_MODE: "panel",
      TZ: "UTC"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-20_000); });
  }
  await waitForServer();

  await runProfile(chromium, {
    ...devices["Pixel 7"],
    viewport: { width: 390, height: 844 }
  }, "Chromium Android 390x844");
  await runProfile(webkit, {
    ...devices["iPhone 13"],
    viewport: { width: 320, height: 568 }
  }, "WebKit iPhone 320x568");
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => server.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 5_000))
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await rm(dataDirectory, { recursive: true, force: true });
}
