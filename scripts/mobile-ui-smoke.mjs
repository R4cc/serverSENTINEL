import { chromium, devices, webkit } from "playwright";
import { launchBrowser, signInThroughForm, startDemoHarness } from "./lib/demo-harness.mjs";

const harness = await startDemoHarness({
  dataDirectoryPrefix: "serversentinel-mobile-smoke-",
  env: { MODRINTH_API_KEY: "demo-token" }
});
const { baseUrl } = harness;

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

  // The server strip used to hide refresh and duplicate behind a "More server actions"
  // overflow menu. Both are promoted to the strip itself now, so there is no menu to
  // open -- assert the promoted control is present and reachable instead.
  assert(await page.locator(".activeServerStrip .refreshStatusButton").count(), `${label}: promoted refresh control is missing from the server strip`);
  assert(await page.getByRole("button", { name: "More server actions" }).count() === 0, `${label}: retired server action menu is back`);
  assert(await page.getByRole("menuitem", { name: "Download log", exact: true }).count() === 0, `${label}: removed console download action is still available`);
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

async function assertScheduleEditorLayout(page, label) {
  const result = await page.evaluate(() => {
    const panel = document.querySelector(".scheduleModalPanel");
    const body = document.querySelector(".scheduleModalPanel .scheduleEditBody");
    const layout = document.querySelector(".scheduleEditorLayout");
    const footer = document.querySelector(".scheduleModalFooter");
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement) || !(layout instanceof HTMLElement) || !(footer instanceof HTMLElement)) return { missing: true };
    const panelRect = panel.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    return {
      missing: false,
      panel: { left: panelRect.left, right: panelRect.right, top: panelRect.top, bottom: panelRect.bottom },
      footer: { left: footerRect.left, right: footerRect.right, top: footerRect.top, bottom: footerRect.bottom },
      viewport: { width: innerWidth, height: innerHeight },
      bodyHorizontalOverflow: body.scrollWidth - body.clientWidth,
      columns: getComputedStyle(layout).gridTemplateColumns,
      sectionCount: layout.querySelectorAll(".scheduleEditorSection").length
    };
  });
  assert(!result.missing, `${label}: schedule editor surfaces are missing`);
  assert(result.panel.left >= 0 && result.panel.right <= result.viewport.width && result.panel.top >= 0 && result.panel.bottom <= result.viewport.height, `${label}: schedule editor leaves the viewport: ${JSON.stringify(result)}`);
  assert(result.footer.left >= 0 && result.footer.right <= result.viewport.width && result.footer.bottom <= result.viewport.height, `${label}: schedule editor footer leaves the viewport: ${JSON.stringify(result)}`);
  assert(result.bodyHorizontalOverflow <= 1, `${label}: schedule editor body overflows horizontally: ${JSON.stringify(result)}`);
  assert(!result.columns.includes(" "), `${label}: schedule editor did not collapse to one column: ${JSON.stringify(result)}`);
  assert(result.sectionCount === 3, `${label}: schedule editor is missing a workflow section: ${JSON.stringify(result)}`);
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

async function assertNodeUpdateToast(page, label) {
  const toast = page.locator(".sonnerToast").filter({ hasText: "Multiple nodes have an update available." });
  await toast.waitFor();
  const mute = toast.getByRole("button", { name: "Mute for 3 days", exact: true });
  const geometry = await toast.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const action = element.querySelector("[data-button]");
    const actionRect = action?.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      actionWidth: actionRect?.width ?? 0,
      actionHeight: actionRect?.height ?? 0
    };
  });
  assert(geometry.left >= 0 && geometry.right <= geometry.viewportWidth && geometry.top >= 0 && geometry.bottom <= geometry.viewportHeight, `${label}: node update toast leaves the viewport: ${JSON.stringify(geometry)}`);
  assert(geometry.actionWidth >= 44 && geometry.actionHeight >= 44, `${label}: node update mute action is smaller than 44px: ${JSON.stringify(geometry)}`);
  await mute.click();
  await page.reload();
  await page.locator(".appShell").waitFor();
  await page.waitForTimeout(100);
  assert(await page.getByText("Multiple nodes have an update available.", { exact: true }).count() === 0, `${label}: muted node update toast returned after reload`);
}

async function assertModsRowsAligned(page, label) {
  const rows = await page.locator(".modsWorkspaceRow:not(.modsWorkspaceSkeletonRow)").evaluateAll((elements) => elements.map((row) => {
    const rect = (selector) => {
      const element = row.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, centerX: bounds.left + bounds.width / 2, centerY: bounds.top + bounds.height / 2 };
    };
    return {
      columns: getComputedStyle(row).gridTemplateColumns,
      metadata: rect(".modsWorkspaceMetadata"),
      status: rect(".modsWorkspaceStatus"),
      version: rect(".modsWorkspaceVersion"),
      enabled: rect(".modsWorkspaceEnabled"),
      switchVersion: rect(".modsWorkspaceSwitchVersionButton")
    };
  }));
  assert(rows.length > 1, `${label}: demo mod rows are missing`);
  assert(rows.every((row) => row.metadata && row.status && row.version && row.enabled && row.switchVersion), `${label}: a mod row is missing an alignment surface`);
  assert(new Set(rows.map((row) => row.columns)).size === 1, `${label}: mod row columns vary with content: ${JSON.stringify(rows.map((row) => row.columns))}`);
  for (const key of ["enabled", "switchVersion"]) {
    const centers = rows.map((row) => row[key].centerX);
    assert(Math.max(...centers) - Math.min(...centers) <= 1, `${label}: ${key} controls do not share a column: ${JSON.stringify(centers)}`);
  }
  assert(rows.every((row) => Math.abs(row.status.centerY - row.version.centerY) <= 1), `${label}: status and installed version are not vertically aligned`);
  assert(rows.every((row) => row.status.right <= row.version.left + 1), `${label}: status and installed version overlap`);
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

async function overviewDensityMetrics(page) {
  return page.evaluate(() => {
    const grid = document.querySelector(".overviewDashboardGrid");
    const summary = document.querySelector(".overviewSummary");
    const players = document.querySelector(".playersPanel");
    const timeline = document.querySelector(".serverTimelinePanel");
    const legacyResourcePanel = document.querySelector(".resourcePanel");
    const playerGrid = document.querySelector(".activePlayerGrid");
    if (!(grid instanceof HTMLElement) || !(summary instanceof HTMLElement)) {
      return { missing: true };
    }
    const children = [...grid.children];
    const visibleSummaryTiles = [...summary.children].filter((element) => element instanceof HTMLElement && getComputedStyle(element).display !== "none").length;
    const summaryRect = summary.getBoundingClientRect();
    const playersRect = players instanceof HTMLElement ? players.getBoundingClientRect() : undefined;
    return {
      missing: false,
      visibleSummaryTiles,
      timeline: timeline instanceof HTMLElement,
      players: players instanceof HTMLElement,
      legacyResourcePanel: legacyResourcePanel instanceof HTMLElement,
      summaryBeforePlayers: players instanceof HTMLElement ? children.indexOf(summary) < children.indexOf(players) : false,
      summaryToPlayersGap: playersRect ? Math.round(playersRect.top - summaryRect.bottom) : null,
      playerColumns: playerGrid instanceof HTMLElement ? getComputedStyle(playerGrid).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length : 0,
      horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth
    };
  });
}

async function assertOverviewDensity(page, profile, label) {
  await openPage(page, "overview");
  await page.locator(".activePlayerGrid").waitFor();

  const portrait = await overviewDensityMetrics(page);
  assert(!portrait.missing, `${label}: portrait Overview surfaces are missing`);
  assert(portrait.visibleSummaryTiles === 5, `${label}: portrait Overview shows ${portrait.visibleSummaryTiles} summary fields instead of five`);
  assert(!portrait.timeline && !portrait.legacyResourcePanel, `${label}: portrait Overview still shows a chart`);
  assert(portrait.players, `${label}: portrait Overview does not show Active Players`);
  assert(portrait.summaryBeforePlayers && portrait.summaryToPlayersGap >= 0 && portrait.summaryToPlayersGap <= 24, `${label}: Active Players is not directly below the portrait summary: ${JSON.stringify(portrait)}`);
  assert(portrait.playerColumns === 2, `${label}: portrait Active Players uses ${portrait.playerColumns} columns instead of two`);
  assert(portrait.horizontalOverflow <= 1, `${label}: portrait Overview overflows horizontally by ${portrait.horizontalOverflow}px`);

  await page.setViewportSize({ width: profile.viewport.height, height: profile.viewport.width });
  await page.locator(".serverTimelinePanel").waitFor();
  const landscape = await overviewDensityMetrics(page);
  assert(!landscape.missing, `${label}: landscape Overview surfaces are missing`);
  assert(landscape.visibleSummaryTiles === 5, `${label}: landscape Overview shows ${landscape.visibleSummaryTiles} summary fields instead of five`);
  assert(landscape.timeline && !landscape.legacyResourcePanel, `${label}: landscape Overview did not switch to the unified timeline`);
  assert(!landscape.players, `${label}: landscape Overview still shows the redundant Active Players card`);
  assert(landscape.horizontalOverflow <= 1, `${label}: landscape Overview overflows horizontally by ${landscape.horizontalOverflow}px`);

  await page.setViewportSize({ width: profile.viewport.width, height: profile.viewport.height });
  await page.locator(".serverTimelinePanel").waitFor({ state: "detached" });
  const restoredPortrait = await overviewDensityMetrics(page);
  assert(!restoredPortrait.timeline && restoredPortrait.players && restoredPortrait.playerColumns === 2, `${label}: Overview did not restore its chartless Active Players layout`);
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
      terminalHeight: terminal.getBoundingClientRect().height,
      panelHeaderPresent: terminalFrame.parentElement?.querySelector(":scope > .uiPanelHeader") !== null
    };
  });
  assert(!result.missing, `${label}: console viewport surfaces are missing`);
  assert(result.documentHeight <= result.documentViewportHeight + 1, `${label}: console leaks into document scrolling: ${JSON.stringify(result)}`);
  assert(result.documentTop === 0, `${label}: console document is scrolled`);
  assert(result.shellOverflow === "hidden" && result.workspaceOverflow === "hidden", `${label}: console shell is not viewport-contained: ${JSON.stringify(result)}`);
  assert(result.documentWidth <= result.documentViewportWidth + 1, `${label}: full-width console causes horizontal overflow: ${JSON.stringify(result)}`);
  assert(result.terminalLeft <= 1 && result.terminalRight >= result.documentViewportWidth - 1, `${label}: console does not reach both viewport edges: ${JSON.stringify(result)}`);
  assert(result.terminalHeight > 0, `${label}: console terminal lost its viewport height`);
  assert(!result.panelHeaderPresent, `${label}: removed console header bar is still present`);
}

/**
 * The console is the one page sized to the visible area rather than scrolled, so it is the one page
 * the software keyboard can take apart: opening it shrinks the visible area and, on iOS, slides it
 * down the page to bring the focused field into view. A shell that keeps its position while the
 * page stays full height ends up a band at the top of the screen above a blank half, with the
 * console out of sight above it.
 *
 * The keyboard cannot be summoned in a headless browser. `installViewportStandIn` puts a visual
 * viewport in its place that behaves identically until a test moves it, which is the whole of what
 * the keyboard does to the page.
 */
async function assertConsoleSurvivesTheKeyboard(page, label) {
  await openPage(page, "console");
  await page.locator(".consolePromptInput").waitFor();

  const openKeyboard = async (inset, offset) => {
    await page.evaluate(({ keyboardInset, viewportOffset }) => {
      window.__keyboardInset = keyboardInset;
      window.__viewportOffset = viewportOffset;
      window.visualViewport.dispatchEvent(new Event("resize"));
      window.visualViewport.dispatchEvent(new Event("scroll"));
    }, { keyboardInset: inset, viewportOffset: offset });
    await page.waitForTimeout(120);
    return page.evaluate(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return null;
        const box = element.getBoundingClientRect();
        return { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height) };
      };
      const owner = document.scrollingElement;
      return {
        visibleTop: window.visualViewport.offsetTop,
        visibleHeight: window.visualViewport.height,
        shell: rect(".appShell"),
        prompt: rect(".consolePrompt"),
        terminal: rect(".minecraftTerminal"),
        scrollHeight: owner instanceof HTMLElement ? owner.scrollHeight : 0,
        clientHeight: owner instanceof HTMLElement ? owner.clientHeight : 0
      };
    });
  };

  const withKeyboard = await openKeyboard(336, 120);
  const visibleBottom = withKeyboard.visibleTop + withKeyboard.visibleHeight;
  assert(withKeyboard.shell && withKeyboard.prompt && withKeyboard.terminal, `${label}: console surfaces are missing under the keyboard`);
  assert(Math.abs(withKeyboard.shell.top - withKeyboard.visibleTop) <= 1, `${label}: the shell stayed behind when the visible area moved down the page: ${JSON.stringify(withKeyboard)}`);
  assert(Math.abs(withKeyboard.shell.height - withKeyboard.visibleHeight) <= 1, `${label}: the shell is not the height of what can be seen: ${JSON.stringify(withKeyboard)}`);
  assert(withKeyboard.prompt.bottom <= visibleBottom + 1, `${label}: the command line sits under the keyboard: ${JSON.stringify(withKeyboard)}`);
  assert(withKeyboard.prompt.top >= withKeyboard.visibleTop - 1, `${label}: the command line sits above what can be seen: ${JSON.stringify(withKeyboard)}`);
  assert(withKeyboard.terminal.height > 0, `${label}: the console lost its height to the keyboard: ${JSON.stringify(withKeyboard)}`);
  assert(withKeyboard.scrollHeight <= withKeyboard.clientHeight + 1, `${label}: the keyboard left a scrollable gap below the console: ${JSON.stringify(withKeyboard)}`);

  const dismissed = await openKeyboard(0, 0);
  assert(Math.abs(dismissed.shell.top) <= 1 && Math.abs(dismissed.shell.height - dismissed.visibleHeight) <= 1, `${label}: the console did not return to full height when the keyboard closed: ${JSON.stringify(dismissed)}`);
  assert(dismissed.terminal.height > withKeyboard.terminal.height, `${label}: the console did not take back the space the keyboard had: ${JSON.stringify({ withKeyboard, dismissed })}`);
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
    browser = await launchBrowser(engine);
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

      // A stand-in for the software keyboard, which a headless browser has no way to raise. It
      // reports the real viewport, and forwards the real events, until a test gives it an inset or
      // an offset — so every assertion that is not about the keyboard sees what it always saw.
      const real = window.visualViewport;
      const standIn = new EventTarget();
      Object.defineProperties(standIn, {
        width: { get: () => real?.width ?? window.innerWidth },
        height: { get: () => (real?.height ?? window.innerHeight) - (window.__keyboardInset ?? 0) },
        offsetLeft: { get: () => real?.offsetLeft ?? 0 },
        offsetTop: { get: () => (real?.offsetTop ?? 0) + (window.__viewportOffset ?? 0) },
        pageLeft: { get: () => real?.pageLeft ?? 0 },
        pageTop: { get: () => real?.pageTop ?? 0 },
        scale: { get: () => real?.scale ?? 1 }
      });
      for (const type of ["resize", "scroll"]) {
        real?.addEventListener(type, () => standIn.dispatchEvent(new Event(type)));
      }
      Object.defineProperty(window, "visualViewport", { configurable: true, get: () => standIn });
    });
    await signInThroughForm(page, baseUrl);

    await assertNodeUpdateToast(page, label);

    assertNativeScrollShell(await shellMetrics(page), `${label} initial`);
    await assertOverviewDensity(page, profile, label);
    await assertNavigationOverlay(page, label);
    await assertTargets(page, [".brandBlock .iconButton", ".activeServerStrip .runtimeControlButton", ".activeServerStrip .refreshStatusButton"], label);
    await assertFloatingSurfaces(page, label);

    for (const title of ["overview", "files", "mods", "schedules", "properties", "nodes", "settings"]) {
      await assertPageDocumentScroll(page, title, `${label} ${title}`);
    }
    await assertConsoleViewportOwnership(page, `${label} console`);
    await assertConsoleSurvivesTheKeyboard(page, `${label} console keyboard`);
    await assertEditableFontSizes(page, `${label} settings`);

    await openPage(page, "files");
    await assertTargets(page, [".fileNavButtons .uiButton", ".fileToolbar .uiButton", ".fileTableRow"], `${label} files`);
    await assertFilesToolbarGeometry(page, `${label} files`);

    await openPage(page, "settings");
    await assertSettingsCategoryGrid(page, `${label} settings`);

    await openPage(page, "mods");
    await assertModsToolbarVisible(page, `${label} mods toolbar`);
    await assertModsRowsAligned(page, `${label} mods rows`);
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
    await assertScheduleEditorLayout(page, `${label} schedule dialog`);
    await page.keyboard.press("Escape");
    await page.locator(".scheduleModalPanel").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Add schedule", null, { timeout: 2_000 });

    await openPage(page, "nodes");
    const nodeDetails = page.getByRole("button", { name: "Details", exact: true }).first();
    await nodeDetails.click();
    await page.locator(".nodeDetailsDrawer").waitFor();
    await assertTargets(page, [".nodeDrawerClose"], `${label} node drawer`);
    const notificationToggle = page.getByRole("checkbox", { name: /Node update notifications for/ });
    assert(await notificationToggle.count() === 1, `${label}: per-node update notification toggle is missing`);
    assert(await notificationToggle.isChecked(), `${label}: per-node update notifications should default to enabled`);
    await page.getByRole("button", { name: "Close node details" }).click();
    await page.locator(".nodeDetailsDrawer").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Details", null, { timeout: 2_000 });

    await openPage(page, "console");
    await page.locator(".xterm-helper-textarea").waitFor({ state: "attached" });
    const terminalHelper = await page.locator(".xterm-helper-textarea").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: rect.width,
        height: rect.height,
        minWidth: style.minWidth,
        minHeight: style.minHeight,
        opacity: style.opacity,
        position: style.position,
        fontSize: style.fontSize
      };
    });
    assert(terminalHelper.opacity === "0" && terminalHelper.position === "absolute", `${label}: xterm helper is visible in the terminal: ${JSON.stringify(terminalHelper)}`);
    assert(Number.parseFloat(terminalHelper.minWidth) === 0 && Number.parseFloat(terminalHelper.minHeight) === 0, `${label}: xterm helper inherited minimum textarea geometry: ${JSON.stringify(terminalHelper)}`);
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
  await runProfile(chromium, {
    ...devices["Pixel 7"],
    viewport: { width: 390, height: 844 }
  }, "Chromium Android 390x844");
  await runProfile(webkit, {
    ...devices["iPhone 13"],
    viewport: { width: 320, height: 568 }
  }, "WebKit iPhone 320x568");
} finally {
  await harness.stop();
}
