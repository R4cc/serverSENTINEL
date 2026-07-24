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
      rootOverflowY: getComputedStyle(document.documentElement).overflowY,
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      shellHeight: shell.getBoundingClientRect().height,
      documentHeight: document.documentElement.scrollHeight,
      viewportVariable: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--visual-viewport-height")),
      workspace: { x: workspaceRect.x, y: workspaceRect.y, width: workspaceRect.width, height: workspaceRect.height }
    };
  });
}

function assertNativeScrollShell(metrics, label) {
  assert(metrics.documentTop === 0 && metrics.bodyTop === 0 && metrics.shellTop === 0, `${label}: document or shell scrolled independently`);
  assert(metrics.shellOverflow === "visible", `${label}: shell blocks document scrolling (${metrics.shellOverflow})`);
  assert(["auto", "scroll", "visible"].includes(metrics.rootOverflowY) && ["auto", "scroll", "visible"].includes(metrics.bodyOverflowY), `${label}: document is not the mobile scroll surface (${metrics.rootOverflow}/${metrics.bodyOverflowY})`);
  assert(metrics.shellHeight >= metrics.viewportVariable - 1, `${label}: shell does not fill the visual viewport`);
  assert(metrics.documentHeight >= metrics.viewportVariable - 1, `${label}: document does not fill the visual viewport`);
}

async function assertNavigationOverlay(page, label) {
  const before = await shellMetrics(page);
  await page.getByRole("button", { name: "Expand navigation" }).click();
  await page.locator(".mobileNavigationOpen").waitFor();
  const open = await shellMetrics(page);
  for (const key of ["x", "y", "width"]) {
    assert(Math.abs(before.workspace[key] - open.workspace[key]) <= 1, `${label}: opening navigation changed workspace ${key} (${before.workspace[key]} -> ${open.workspace[key]})`);
  }
  assertNativeScrollShell(open, `${label} navigation open`);
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

async function assertScheduleActionMenuVisible(page, label) {
  const trigger = page.locator(".scheduleActionMenuTrigger").first();
  assert(await trigger.count(), `${label}: demo schedule action trigger is missing`);
  await trigger.click();
  const menu = page.locator(".scheduleActionMenu .actionMenuPopover").first();
  await menu.waitFor();
  const geometry = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const sampleX = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const sampleYs = [rect.top + 2, rect.bottom - 2].map((value) => Math.min(innerHeight - 1, Math.max(0, value)));
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      samplesInsideMenu: sampleYs.map((y) => element.contains(document.elementFromPoint(sampleX, y)))
    };
  });
  assert(geometry.left >= 0 && geometry.right <= geometry.viewportWidth && geometry.top >= 0 && geometry.bottom <= geometry.viewportHeight, `${label}: schedule action menu leaves the viewport: ${JSON.stringify(geometry)}`);
  assert(geometry.samplesInsideMenu.every(Boolean), `${label}: schedule action menu is clipped by its card: ${JSON.stringify(geometry)}`);
  await page.keyboard.press("Escape");
}

async function assertModsToolbarVisible(page, label) {
  const result = await page.evaluate(() => {
    const toolbar = document.querySelector(".modsWorkspaceToolbar");
    const installed = document.querySelector(".modsWorkspaceInstalled");
    const documentScroller = document.scrollingElement;
    const actions = Array.from(document.querySelectorAll(".modsWorkspaceToolbar button"));
    if (!(toolbar instanceof HTMLElement) || !(installed instanceof HTMLElement) || !(documentScroller instanceof HTMLElement) || actions.length === 0) return { missing: true };
    const toolbarRect = toolbar.getBoundingClientRect();
    const installedRect = installed.getBoundingClientRect();
    const originalTop = documentScroller.scrollTop;
    const coveredActions = actions.flatMap((action) => {
      let rect = action.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > innerHeight) {
        documentScroller.scrollTop += rect.top - Math.max(0, (innerHeight - rect.height) / 2);
        rect = action.getBoundingClientRect();
      }
      const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
      const y = Math.min(innerHeight - 1, Math.max(0, rect.top + Math.min(rect.height / 2, 8)));
      const hit = document.elementFromPoint(x, y);
      return action.contains(hit) ? [] : [action.getAttribute("aria-label") || action.textContent?.trim() || "unnamed action"];
    });
    documentScroller.scrollTop = originalTop;
    return {
      missing: false,
      toolbarBottom: toolbarRect.bottom,
      installedTop: installedRect.top,
      coveredActions
    };
  });
  assert(!result.missing, `${label}: mods toolbar surfaces are missing`);
  assert(result.installedTop >= result.toolbarBottom, `${label}: installed mods overlaps the toolbar (${result.installedTop} < ${result.toolbarBottom})`);
  assert(result.coveredActions.length === 0, `${label}: mods toolbar actions are covered: ${JSON.stringify(result.coveredActions)}`);
}

async function assertPageDocumentScroll(page, title, label) {
  await openPage(page, title);
  const result = await page.evaluate(() => {
    const shell = document.querySelector(".appShell");
    const workspace = document.querySelector(".workspace");
    const owner = document.scrollingElement;
    if (!(shell instanceof HTMLElement) || !(workspace instanceof HTMLElement) || !(owner instanceof HTMLElement)) return { missing: true };
    const before = owner.scrollTop;
    if (owner.scrollHeight > owner.clientHeight) owner.scrollTop = Math.min(80, owner.scrollHeight - owner.clientHeight);
    const moved = owner.scrollTop > before;
    owner.scrollTop = before;
    return {
      missing: false,
      rootOverflow: getComputedStyle(document.documentElement).overflowY,
      bodyOverflow: getComputedStyle(document.body).overflowY,
      canOverflow: owner.scrollHeight > owner.clientHeight,
      moved,
      shellTop: shell.scrollTop,
      horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth
    };
  });
  assert(!result.missing, `${label}: document scroll surface is missing`);
  assert(["auto", "scroll", "visible"].includes(result.rootOverflow) && ["auto", "scroll", "visible"].includes(result.bodyOverflow), `${label}: document scrolling is disabled`);
  assert(!result.canOverflow || result.moved, `${label}: document cannot reach overflowing content`);
  assert(result.shellTop === 0, `${label}: shell became a competing scroll surface`);
  assert(result.horizontalOverflow <= 1, `${label}: page has horizontal overflow (${result.horizontalOverflow}px)`);
}

async function assertFilesToolbarGeometry(page, label) {
  const result = await page.evaluate(() => {
    const navigation = document.querySelector(".fileNavButtons");
    const breadcrumbs = document.querySelector(".fileBreadcrumbs");
    const actions = document.querySelector(".fileToolbar");
    if (!(navigation instanceof HTMLElement) || !(breadcrumbs instanceof HTMLElement) || !(actions instanceof HTMLElement)) return { missing: true };
    const nav = navigation.getBoundingClientRect();
    const crumbs = breadcrumbs.getBoundingClientRect();
    const toolbar = actions.getBoundingClientRect();
    return {
      missing: false,
      navBottom: nav.bottom,
      crumbsTop: crumbs.top,
      crumbsBottom: crumbs.bottom,
      toolbarTop: toolbar.top,
      navWithinViewport: nav.left >= 0 && nav.right <= innerWidth,
      crumbsWithinViewport: crumbs.left >= 0 && crumbs.right <= innerWidth,
      toolbarWithinViewport: toolbar.left >= 0 && toolbar.right <= innerWidth
    };
  });
  assert(!result.missing, `${label}: Files toolbar groups are missing`);
  assert(result.navBottom <= result.crumbsTop + 1 && result.crumbsBottom <= result.toolbarTop + 1, `${label}: Files toolbar groups overlap: ${JSON.stringify(result)}`);
  assert(result.navWithinViewport && result.crumbsWithinViewport && result.toolbarWithinViewport, `${label}: Files toolbar leaves the viewport: ${JSON.stringify(result)}`);
}

async function assertSettingsCategoryGrid(page, label) {
  const result = await page.locator(".settingsHubCategories").evaluate((element) => {
    const style = getComputedStyle(element);
    const buttons = Array.from(element.querySelectorAll("button"));
    const rows = new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)));
    return {
      display: style.display,
      columns: style.gridTemplateColumns.split(" ").filter(Boolean).length,
      rows: rows.size,
      overflowX: style.overflowX,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth
    };
  });
  assert(result.display === "grid" && result.columns === 2 && result.rows >= 2, `${label}: Settings categories are not a two-column grid: ${JSON.stringify(result)}`);
  assert(result.scrollWidth <= result.clientWidth + 1, `${label}: Settings categories scroll horizontally: ${JSON.stringify(result)}`);
}

async function assertConsoleViewportOwnership(page, label) {
  await openPage(page, "console");
  await page.locator(".minecraftTerminal").waitFor();
  const result = await page.evaluate(() => {
    const shell = document.querySelector(".appShell");
    const workspace = document.querySelector(".workspacePage-console");
    const terminalFrame = document.querySelector(".consolePanel > .terminal");
    const terminal = document.querySelector(".minecraftTerminal");
    const owner = document.scrollingElement;
    if (!(shell instanceof HTMLElement) || !(workspace instanceof HTMLElement) || !(terminalFrame instanceof HTMLElement) || !(terminal instanceof HTMLElement) || !(owner instanceof HTMLElement)) return { missing: true };
    const terminalRect = terminalFrame.getBoundingClientRect();
    const panelRect = terminalFrame.parentElement?.getBoundingClientRect();
    const pageRect = terminalFrame.parentElement?.parentElement?.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    return {
      missing: false,
      documentHeight: owner.scrollHeight,
      documentViewportHeight: owner.clientHeight,
      documentWidth: owner.scrollWidth,
      documentViewportWidth: owner.clientWidth,
      documentTop: owner.scrollTop,
      shellOverflow: getComputedStyle(shell).overflow,
      workspaceOverflow: getComputedStyle(workspace).overflow,
      workspaceRect: { left: workspaceRect.left, right: workspaceRect.right, width: workspaceRect.width },
      pageRect: pageRect ? { left: pageRect.left, right: pageRect.right, width: pageRect.width } : null,
      panelRect: panelRect ? { left: panelRect.left, right: panelRect.right, width: panelRect.width } : null,
      terminalLeft: terminalRect.left,
      terminalRight: terminalRect.right,
      terminalHeight: terminal.getBoundingClientRect().height
    };
  });
  assert(!result.missing, `${label}: console viewport surfaces are missing`);
  assert(result.documentHeight <= result.documentViewportHeight + 1, `${label}: console leaks into document scrolling: ${JSON.stringify(result)}`);
  assert(result.documentTop === 0, `${label}: console document is scrolled`);
  assert(result.shellOverflow === "hidden" && result.workspaceOverflow === "hidden", `${label}: console shell is not viewport-contained: ${JSON.stringify(result)}`);
  assert(result.documentWidth <= result.documentViewportWidth + 1, `${label}: full-width console causes horizontal overflow: ${JSON.stringify(result)}`);
  assert(result.terminalLeft <= 1 && result.terminalRight >= result.documentViewportWidth - 1, `${label}: console does not reach both viewport edges: ${JSON.stringify(result)}`);
  assert(result.terminalHeight > 0, `${label}: console terminal lost its viewport height`);
}

async function assertDialogScrollLock(page, backdropSelector, dialogBodySelector, label) {
  const result = await page.evaluate(({ backdropSelector: backdrop, dialogBodySelector: body }) => {
    const backdropElement = document.querySelector(backdrop);
    const bodyElement = document.querySelector(body);
    const backgroundElement = document.scrollingElement;
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
  }, { backdropSelector, dialogBodySelector });
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

    assertNativeScrollShell(await shellMetrics(page), `${label} initial`);
    await assertNavigationOverlay(page, label);
    await assertTargets(page, [".brandBlock .iconButton", ".activeServerStrip .runtimeControlButton", ".activeServerStrip .overflowButton"], label);
    await assertFloatingSurfaces(page, label);

    for (const title of ["overview", "files", "mods", "schedules", "properties", "nodes", "settings"]) {
      await assertPageDocumentScroll(page, title, `${label} ${title}`);
    }
    await assertConsoleViewportOwnership(page, `${label} console`);
    await assertEditableFontSizes(page, `${label} settings`);

    await openPage(page, "files");
    await assertTargets(page, [".fileNavButtons .uiButton", ".fileToolbar .uiButton", ".fileTableRow"], `${label} files`);
    await assertFilesToolbarGeometry(page, `${label} files`);

    await openPage(page, "settings");
    await assertSettingsCategoryGrid(page, `${label} settings`);

    await openPage(page, "mods");
    await assertModsToolbarVisible(page, `${label} mods toolbar`);
    const addMods = page.getByRole("button", { name: "Add mods", exact: true });
    assert(await addMods.isEnabled(), `${label}: demo Add mods action is unexpectedly disabled`);
    await addMods.click();
    await page.getByRole("dialog", { name: "Add mods", exact: true }).waitFor();
    await assertEditableFontSizes(page, `${label} mods drawer`);
    await assertTargets(page, [".modsDrawerHeader button"], `${label} mods drawer`);
    await assertDialogScrollLock(page, ".modsDrawerBackdrop", ".modsDrawerBody", `${label} mods drawer`);
    await page.getByRole("button", { name: "Close add mods" }).click();

    await openPage(page, "schedules");
    await assertScheduleActionMenuVisible(page, `${label} schedule row`);
    const scheduleTrigger = page.getByRole("button", { name: "Add schedule", exact: true });
    await scheduleTrigger.click();
    await page.getByRole("dialog").waitFor();
    await assertEditableFontSizes(page, `${label} schedule dialog`);
    await assertTargets(page, [".scheduleModalPanel .modalCloseButton"], `${label} schedule dialog`);
    await assertDialogScrollLock(page, ".scheduleModalBackdrop", ".scheduleModalPanel .scheduleEditBody", `${label} schedule dialog`);
    await page.keyboard.press("Escape");
    await page.locator(".scheduleModalPanel").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Add schedule", null, { timeout: 2_000 });

    await openPage(page, "nodes");
    const nodeDetails = page.getByRole("button", { name: "Details", exact: true }).first();
    await nodeDetails.click();
    await page.locator(".nodeDetailsDrawer").waitFor();
    await assertTargets(page, [".nodeDrawerClose"], `${label} node drawer`);
    await page.getByRole("button", { name: "Close node details" }).click();
    await page.locator(".nodeDetailsDrawer").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Details", null, { timeout: 2_000 });

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
    await assertConsoleViewportOwnership(page, `${label} resized console viewport`);

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
      SS_MODE: "all-in-one",
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
