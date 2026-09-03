import assert from "node:assert/strict";
import { chromium, devices, webkit } from "playwright";
import { launchBrowser, signInThroughApi, signInThroughForm, startDemoHarness } from "./lib/demo-harness.mjs";

const harness = await startDemoHarness({
  dataDirectoryPrefix: "serversentinel-mobile-smoke-",
  env: { MODRINTH_API_KEY: "demo-token" }
});
const { baseUrl } = harness;

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
  await assertTargets(page, [".accountLogoutButton"], `${label} navigation`);
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

async function assertNearestVisibleMapPopupContained(page, label) {
  const markerIndex = await page.evaluate(() => {
    const frame = document.querySelector(".playerMapFrame")?.getBoundingClientRect();
    if (!frame) return -1;
    const candidates = Array.from(document.querySelectorAll(".playerMapMarker")).map((marker, index) => {
      const rect = marker.getBoundingClientRect();
      const centreX = rect.left + rect.width / 2;
      const centreY = rect.top + rect.height / 2;
      const visible = centreX >= frame.left && centreX <= frame.right && centreY >= frame.top && centreY <= frame.bottom;
      const edgeDistance = Math.min(centreX - frame.left, frame.right - centreX, centreY - frame.top, frame.bottom - centreY);
      return { index, visible, edgeDistance };
    }).filter(({ visible }) => visible).sort((left, right) => left.edgeDistance - right.edgeDistance);
    return candidates[0]?.index ?? -1;
  });
  assert(markerIndex >= 0, `${label}: no visible player marker was available for edge-popup verification`);

  const marker = page.locator(".playerMapMarker").nth(markerIndex);
  await marker.hover();
  const popup = page.locator(".playerMapClusterPopup");
  await popup.waitFor();
  await page.waitForFunction(() => document.querySelector(".playerMapClusterPopup")?.getAttribute("data-placement"));
  const geometry = await page.evaluate(() => {
    const frame = document.querySelector(".playerMapFrame")?.getBoundingClientRect();
    const marker = document.querySelector(".playerMapMarkerWrap--active .playerMapMarker")?.getBoundingClientRect();
    const popup = document.querySelector(".playerMapClusterPopup")?.getBoundingClientRect();
    if (!frame || !marker || !popup) return { missing: true };
    return {
      missing: false,
      left: popup.left - frame.left,
      right: frame.right - popup.right,
      top: popup.top - frame.top,
      bottom: frame.bottom - popup.bottom,
      separated: popup.bottom <= marker.top - 8 || popup.top >= marker.bottom + 8
    };
  });
  assert(!geometry.missing, `${label}: the edge marker or popup disappeared`);
  for (const edge of ["left", "right", "top", "bottom"]) {
    assert(geometry[edge] >= 7, `${label}: popup crossed the map's ${edge} inset: ${JSON.stringify(geometry)}`);
  }
  assert(geometry.separated, `${label}: constrained popup covered its player marker: ${JSON.stringify(geometry)}`);

  await page.getByRole("button", { name: "Reset map view" }).hover();
  await popup.waitFor({ state: "detached" });
}

async function assertPlayerMarkerAnchorsAcrossTransforms(page, label, {
  requirePingLabels = false,
  exerciseScopeSwitch = false
} = {}) {
  const assertScreenSized = async (phase) => {
    const measurements = await page.evaluate(() => {
      const visualScale = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.textContent?.trim() || element.getAttribute("class"),
          x: rect.width / element.offsetWidth,
          y: rect.height / element.offsetHeight
        };
      };
      return {
        avatars: Array.from(document.querySelectorAll(".playerMapMarker .playerMapAvatar")).map(visualScale),
        pingLabels: Array.from(document.querySelectorAll(".playerMapPingLabel")).map(visualScale)
      };
    });
    assert(measurements.avatars.length > 0, `${label} ${phase}: fixed-size player heads are missing`);
    if (requirePingLabels) {
      assert(measurements.pingLabels.length > 0, `${label} ${phase}: fixed-size map ping labels are missing`);
    }
    const drifting = [...measurements.avatars, ...measurements.pingLabels]
      .filter(({ x, y }) => Math.abs(x - 1) > 0.04 || Math.abs(y - 1) > 0.04);
    assert(drifting.length === 0, `${label} ${phase}: map annotations inherited the map zoom: ${JSON.stringify(drifting)}`);
  };

  const assertAnchored = async (phase) => {
    const measurements = await page.locator(".playerMapMarkerWrap").evaluateAll((wrappers) => {
      const content = document.querySelector(".playerMapTransformContent");
      if (!(content instanceof HTMLElement)) return [];
      const contentRect = content.getBoundingClientRect();
      return wrappers.flatMap((wrapper) => {
        const marker = wrapper.querySelector(".playerMapMarker");
        if (!(wrapper instanceof HTMLElement) || !(marker instanceof HTMLElement)) return [];
        const markerRect = marker.getBoundingClientRect();
        const left = Number.parseFloat(wrapper.style.left) / 100;
        const top = Number.parseFloat(wrapper.style.top) / 100;
        const expected = {
          x: contentRect.left + contentRect.width * left,
          y: contentRect.top + contentRect.height * top
        };
        const actual = {
          x: markerRect.left + markerRect.width / 2,
          y: markerRect.top + markerRect.height / 2
        };
        return [{
          label: marker.getAttribute("aria-label"),
          delta: Math.hypot(actual.x - expected.x, actual.y - expected.y),
          expected,
          actual
        }];
      });
    });
    assert(measurements.length > 0, `${label} ${phase}: player map markers are missing`);
    const drifting = measurements.filter(({ delta }) => delta > 1.5);
    assert(drifting.length === 0, `${label} ${phase}: marker centers drifted from their transformed projected coordinates: ${JSON.stringify(drifting)}`);
    await assertScreenSized(phase);
  };

  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  await assertAnchored("at 100% zoom");
  await zoomIn.click();
  await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector(".playerMapTransformContent")).transform).a >= 1.49);
  await page.waitForTimeout(100);
  await assertAnchored("at intermediate zoom");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const currentScale = await page.locator(".playerMapTransformContent").evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
    if (currentScale >= 3.99) break;
    const clicked = await zoomIn.evaluate((button) => {
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    });
    if (!clicked) break;
    await page.waitForFunction((previous) => new DOMMatrix(getComputedStyle(document.querySelector(".playerMapTransformContent")).transform).a > previous + 0.01, currentScale);
    await page.waitForTimeout(250);
  }
  await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector(".playerMapTransformContent")).transform).a >= 3.99);
  await page.waitForTimeout(100);
  await assertAnchored("at 4x zoom");

  if (exerciseScopeSwitch) {
    const mapScope = page.getByRole("group", { name: "Players shown on map" });
    for (const scope of ["Online", "All time"]) {
      const button = mapScope.getByRole("button", { name: scope, exact: true });
      await button.click();
      await page.waitForFunction((name) => document.querySelector(`[aria-label="Players shown on map"] button[aria-pressed="true"]`)?.textContent?.trim() === name, scope);
      await assertAnchored(`after switching to ${scope.toLowerCase()} at 4x zoom`);
    }
    await assertNearestVisibleMapPopupContained(page, `${label} after scope switching at 4x zoom`);
  }

  const mapTransform = page.locator(".playerMapTransformContent");
  const beforePan = await mapTransform.evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f };
  });
  const frame = await page.locator(".playerMapFrame").boundingBox();
  assert(frame, `${label}: player map frame is missing`);
  await page.mouse.move(frame.x + frame.width * 0.5, frame.y + frame.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.65, frame.y + frame.height * 0.7, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(({ x, y }) => {
    const matrix = new DOMMatrix(getComputedStyle(document.querySelector(".playerMapTransformContent")).transform);
    return Math.hypot(matrix.e - x, matrix.f - y) >= 3;
  }, beforePan);
  await assertAnchored("after panning");
  if (exerciseScopeSwitch) {
    await assertNearestVisibleMapPopupContained(page, `${label} after panning at 4x zoom`);
  }

  await page.getByRole("button", { name: "Reset map view" }).click();
  await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector(".playerMapTransformContent")).transform).a <= 1.01);
}

async function assertPlayerClusterPopupDismisses(page, label) {
  await openPage(page, "players");
  const helpTrigger = page.getByRole("button", { name: "About player geography", exact: true });
  await helpTrigger.waitFor();
  const helpTarget = await helpTrigger.getAttribute("aria-controls");
  assert(helpTarget, `${label}: player geography help is not associated with its tooltip`);
  const beforeHelp = await page.locator(".playerGeographyCard").evaluate((card) => {
    const cardRect = card.getBoundingClientRect();
    const mapRect = card.querySelector(".playerMapFrame")?.getBoundingClientRect();
    const triggerRect = card.querySelector('.uiHelpTooltipButton[aria-label="About player geography"]')?.getBoundingClientRect();
    return {
      cardHeight: cardRect.height,
      mapOffset: mapRect ? mapRect.top - cardRect.top : 0,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      triggerWidth: triggerRect?.width ?? 0,
      triggerHeight: triggerRect?.height ?? 0
    };
  });
  assert(beforeHelp.triggerWidth >= 44 && beforeHelp.triggerHeight >= 44, `${label}: player geography help target is smaller than 44px: ${JSON.stringify(beforeHelp)}`);
  await helpTrigger.tap();
  const helpTooltip = page.locator(`[id="${helpTarget}"]`);
  await helpTooltip.waitFor({ state: "visible" });
  const openHelp = await helpTooltip.evaluate((tooltip) => {
    const rect = tooltip.getBoundingClientRect();
    const card = document.querySelector(".playerGeographyCard");
    const mapRect = card?.querySelector(".playerMapFrame")?.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: window.visualViewport?.width ?? innerWidth,
      viewportHeight: window.visualViewport?.height ?? innerHeight,
      viewportLeft: window.visualViewport?.offsetLeft ?? 0,
      viewportTop: window.visualViewport?.offsetTop ?? 0,
      cardHeight: card?.getBoundingClientRect().height ?? 0,
      mapOffset: card && mapRect ? mapRect.top - card.getBoundingClientRect().top : 0,
      documentWidth: document.documentElement.scrollWidth
    };
  });
  assert(openHelp.left >= openHelp.viewportLeft && openHelp.right <= openHelp.viewportLeft + openHelp.viewportWidth && openHelp.top >= openHelp.viewportTop && openHelp.bottom <= openHelp.viewportTop + openHelp.viewportHeight, `${label}: player geography help leaves the visual viewport: ${JSON.stringify(openHelp)}`);
  assert(Math.abs(openHelp.cardHeight - beforeHelp.cardHeight) <= 1 && Math.abs(openHelp.mapOffset - beforeHelp.mapOffset) <= 1, `${label}: opening help shifts the geography card: ${JSON.stringify({ beforeHelp, openHelp })}`);
  assert(openHelp.documentWidth <= openHelp.viewportWidth && beforeHelp.documentWidth <= beforeHelp.viewportWidth, `${label}: player geography help causes horizontal overflow: ${JSON.stringify({ beforeHelp, openHelp })}`);
  await page.locator(".playerMap").tap({ position: { x: 2, y: 2 } });
  await helpTooltip.waitFor({ state: "hidden" });

  const mapScope = page.getByRole("group", { name: "Players shown on map" });
  const onlineScope = mapScope.getByRole("button", { name: "Online", exact: true });
  const allTimeScope = mapScope.getByRole("button", { name: "All time", exact: true });
  await assertTargets(page, [".playerMapScopeSwitch .uiButton"], `${label} map scope`);
  assert.equal(await onlineScope.getAttribute("aria-pressed"), "true", `${label}: player map does not default to online players`);
  const onlineMapLabel = await page.locator(".playerMapCanvas").getAttribute("aria-label");
  await allTimeScope.click();
  assert.equal(await allTimeScope.getAttribute("aria-pressed"), "true", `${label}: all-time player map toggle did not activate`);
  const allTimeMapLabel = await page.locator(".playerMapCanvas").getAttribute("aria-label");
  const onlinePlayers = Number(onlineMapLabel?.match(/for (\d+) located players/)?.[1] ?? 0);
  const allTimePlayers = Number(allTimeMapLabel?.match(/for (\d+) located players/)?.[1] ?? 0);
  assert(allTimePlayers > onlinePlayers, `${label}: all-time map did not add historical players (${onlinePlayers} online, ${allTimePlayers} all time)`);
  assert.equal(await page.locator(".playerMapAvatar--online, .playerMapAvatar--known, .playerMapMarker--online, .playerMapMarker--known").count(), 0, `${label}: player map still encodes online status in marker styling`);

  await assertTargets(page, [
    ".playerMapControlButton:nth-child(1)",
    ".playerMapControlButton:nth-child(2)",
    ".playerMapControlButton:nth-child(3)"
  ], `${label} map controls`);
  const mapMarker = page.locator(".playerMapViewport .playerMapAvatar").first();
  const initialMarker = await mapMarker.boundingBox();
  assert(initialMarker && initialMarker.width <= 20.5 && initialMarker.height <= 20.5, `${label}: mobile player marker is still too large: ${JSON.stringify(initialMarker)}`);
  await assertPlayerMarkerAnchorsAcrossTransforms(page, label);

  const serverCluster = page.locator(".playerMapClusterMarker--server");
  const cluster = await serverCluster.count() ? serverCluster : page.locator(".playerMapClusterMarker").first();
  await cluster.waitFor();
  await cluster.click();

  const popup = page.locator(".playerMapClusterPopup");
  await popup.waitFor();
  assert(await cluster.getAttribute("aria-expanded") === "true", `${label}: player cluster did not expand`);
  const geometry = await page.evaluate(() => {
    const marker = document.querySelector('.playerMapClusterMarker[aria-expanded="true"]');
    const serverMarker = document.querySelector(".playerMapMarkerWrap--server .playerMapMarker");
    const serverBadge = document.querySelector(".playerMapSharedServer");
    const standaloneServer = document.querySelector(".playerMapServer");
    const halo = document.querySelector(".playerMapAccuracy--active");
    const popup = document.querySelector(".playerMapClusterPopup");
    const list = popup?.querySelector(".playerMapClusterList");
    if (!(marker instanceof HTMLElement) || !(halo instanceof SVGGraphicsElement) || !(popup instanceof HTMLElement) || !(list instanceof HTMLElement)) return { missing: true };
    const markerRect = marker.getBoundingClientRect();
    const viewportRect = document.querySelector(".playerMapViewport")?.getBoundingClientRect();
    const haloRect = halo.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const pings = Array.from(popup.querySelectorAll(".playerMapClusterRow .playerMapPingValue"));
    const avatar = document.querySelector(".playerMapAvatar");
    const avatarRect = avatar?.getBoundingClientRect();
    return {
      missing: false,
      centreDelta: Math.hypot(
        markerRect.left + markerRect.width / 2 - haloRect.left - haloRect.width / 2,
        markerRect.top + markerRect.height / 2 - haloRect.top - haloRect.height / 2
      ),
      standaloneServerMarkers: document.querySelectorAll(".playerMapServer").length,
      sharedServerIcons: document.querySelectorAll(".playerMapSharedServerIcon").length,
      runningServerMarkers: document.querySelectorAll(".playerMapSharedServer--running, .playerMapServer--running").length,
      serverBadgeAbovePlayers: serverBadge instanceof HTMLElement && serverMarker instanceof HTMLElement
        ? serverBadge.getBoundingClientRect().bottom <= serverMarker.getBoundingClientRect().top + 3
        : standaloneServer instanceof SVGGraphicsElement,
      popupOverflow: popup.scrollWidth - popup.clientWidth,
      popupFrameInset: viewportRect
        ? Math.min(popupRect.left - viewportRect.left, viewportRect.right - popupRect.right, popupRect.top - viewportRect.top, viewportRect.bottom - popupRect.bottom)
        : Number.NEGATIVE_INFINITY,
      overflowingRows: Array.from(popup.querySelectorAll(".playerMapClusterRow")).filter((row) => row.scrollWidth > row.clientWidth + 1).length,
      pingScrollbarClearance: listRect.right - Math.max(...pings.map((ping) => ping.getBoundingClientRect().right)),
      avatarIsSquare: avatarRect ? Math.abs(avatarRect.width - avatarRect.height) <= 1 : false,
      avatarRadius: avatar instanceof HTMLElement ? Number.parseFloat(getComputedStyle(avatar).borderRadius) : Number.POSITIVE_INFINITY,
      overflowingMarkerSurfaces: viewportRect
        ? Array.from(document.querySelectorAll(".playerMapMarker, .playerMapClusterCount, .playerMapSharedServer")).filter((surface) => {
          const rect = surface.getBoundingClientRect();
          return rect.left < viewportRect.left - 1 || rect.right > viewportRect.right + 1 || rect.top < viewportRect.top - 1 || rect.bottom > viewportRect.bottom + 1;
        }).length
        : Number.POSITIVE_INFINITY
    };
  });
  assert(!geometry.missing, `${label}: player cluster marker surfaces are missing`);
  assert(geometry.centreDelta <= 1.5, `${label}: active accuracy halo is offset from the combined marker by ${geometry.centreDelta}px`);
  assert(geometry.standaloneServerMarkers + geometry.sharedServerIcons === 1, `${label}: server marker representation is missing or duplicated`);
  assert(geometry.runningServerMarkers === 1 && geometry.serverBadgeAbovePlayers, `${label}: running server marker is not visually distinct`);
  assert(geometry.popupOverflow <= 1 && geometry.overflowingRows === 0, `${label}: cluster popup content overflows horizontally`);
  assert(geometry.popupFrameInset >= 6, `${label}: cluster popup crosses the visible map frame (${geometry.popupFrameInset}px inset)`);
  assert(geometry.pingScrollbarClearance >= 12, `${label}: popup scrollbar overlaps player ping values (${geometry.pingScrollbarClearance}px clearance)`);
  assert(geometry.avatarIsSquare && geometry.avatarRadius <= 4, `${label}: player head border does not fit the square avatar`);
  assert(geometry.overflowingMarkerSurfaces === 0, `${label}: ${geometry.overflowingMarkerSurfaces} player marker surfaces cross the map frame`);

  // Blank map space is outside the floating panel even though it remains inside the map viewport.
  // This catches the old map-level boundary that left the popup pinned until navigation changed.
  const mapFrame = await page.locator(".playerMapFrame").boundingBox();
  assert(mapFrame, `${label}: player map frame disappeared`);
  await page.mouse.click(mapFrame.x + 2, mapFrame.y + 2);
  await popup.waitFor({ state: "detached" });
  assert(await cluster.getAttribute("aria-expanded") === "false", `${label}: player cluster stayed expanded after an outside click`);
  assert(await cluster.getAttribute("aria-controls") === null, `${label}: dismissed player cluster kept a popup reference`);

}

async function assertConfiguredPlayerAddressEditor() {
  const label = "Chromium Android configured player address";
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({
      ...devices["Pixel 7"],
      viewport: { width: 390, height: 844 },
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "reduce"
    });
    await signInThroughApi(context, baseUrl);
    const sessionResponse = await context.request.get(`${baseUrl}/api/auth/session`, {
      headers: { "X-Requested-With": "XMLHttpRequest" }
    });
    const session = await sessionResponse.json();
    const now = new Date().toISOString();
    const server = {
      id: "browser-test",
      nodeId: "local",
      displayName: "Browser Test",
      directoryLabel: "/browser-test",
      runtimeProfile: {
        minecraftVersion: "1.21.4",
        runtimeType: "fabric",
        runtimeVersion: "0.16.10",
        javaMajorVersion: 21,
        jarProvider: "mcjars",
        jarArtifact: { filename: "fabric-server-launch.jar" },
        compatibilityStatus: "compatible",
        resolvedAt: now
      },
      hasDockerContainer: true,
      createdAt: now,
      updatedAt: now
    };
    const page = await context.newPage();
    await page.route("**/api/auth/session", (route) => route.fulfill({ json: { ...session, demo: false } }));
    await page.route("**/api/app", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, servers: [server], currentUser: session.user } });
    });
    await page.route("**/api/players/insights?*", (route) => route.fulfill({ json: {
      generatedAt: now,
      timeZone: "UTC",
      summary: { countries: 0, onlinePlayers: 0, locatedPlayers: 0, knownPlayers: 0 },
      players: [],
      regions: [],
      latency: [],
      pingMeasurements: [{ serverId: server.id, status: "idle", onlinePlayers: 0, measuredPlayers: 0 }],
      activityHours: Array.from({ length: 24 }, (_, hour) => ({ hour, averagePlayers: 0, peakPlayers: 0, samples: 0 })),
      serverLocations: [{ serverId: server.id, address: "play.example.net" }],
      geoDatabase: { available: false, configured: false, updating: false },
      attribution: "This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com"
    } }));
    await page.addInitScript(() => localStorage.setItem("serversentinel-theme", "light"));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".appShell").waitFor();
    await openPage(page, "players");

    const addressToggle = page.locator(".playerLocationDisclosureToggle");
    await addressToggle.waitFor();
    assert.equal(await addressToggle.getAttribute("aria-expanded"), "false", `${label}: configured server address editor is not collapsed`);
    assert.equal(await page.locator("#player-insights-server-address").count(), 0, `${label}: collapsed server address editor still renders its field`);
    await addressToggle.click();
    const addressInput = page.locator("#player-insights-server-address");
    await addressInput.waitFor();
    const heights = await page.evaluate(() => ({
      input: document.querySelector("#player-insights-server-address")?.getBoundingClientRect().height ?? 0,
      save: document.querySelector(".playerLocationForm > .uiButton")?.getBoundingClientRect().height ?? 0
    }));
    assert(Math.abs(heights.input - 44) <= 0.5 && Math.abs(heights.save - 44) <= 0.5, `${label}: input and Save button are not matching 44px controls: ${JSON.stringify(heights)}`);
    await addressToggle.click();
    await addressInput.waitFor({ state: "detached" });
    await context.close();
    console.log(`mobile smoke passed: ${label}`);
  } finally {
    if (browser) await browser.close();
  }
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
    const header = document.querySelector(".scheduleModalHeader");
    const body = document.querySelector(".scheduleModalPanel .scheduleEditBody");
    const layout = document.querySelector(".scheduleEditorLayout");
    const footer = document.querySelector(".scheduleModalFooter");
    if (!(panel instanceof HTMLElement) || !(header instanceof HTMLElement) || !(body instanceof HTMLElement) || !(layout instanceof HTMLElement) || !(footer instanceof HTMLElement)) return { missing: true };
    const panelRect = panel.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    return {
      missing: false,
      panel: { left: panelRect.left, right: panelRect.right, top: panelRect.top, bottom: panelRect.bottom },
      footer: { left: footerRect.left, right: footerRect.right, top: footerRect.top, bottom: footerRect.bottom },
      surfaceGaps: {
        headerToBody: bodyRect.top - headerRect.bottom,
        bodyToFooter: footerRect.top - bodyRect.bottom
      },
      viewport: { width: innerWidth, height: innerHeight },
      bodyHorizontalOverflow: body.scrollWidth - body.clientWidth,
      columns: getComputedStyle(layout).gridTemplateColumns,
      sectionCount: layout.querySelectorAll(".scheduleEditorSection").length
    };
  });
  assert(!result.missing, `${label}: schedule editor surfaces are missing`);
  assert(result.panel.left >= 0 && result.panel.right <= result.viewport.width && result.panel.top >= 0 && result.panel.bottom <= result.viewport.height, `${label}: schedule editor leaves the viewport: ${JSON.stringify(result)}`);
  assert(result.footer.left >= 0 && result.footer.right <= result.viewport.width && result.footer.bottom <= result.viewport.height, `${label}: schedule editor footer leaves the viewport: ${JSON.stringify(result)}`);
  assert(result.surfaceGaps.headerToBody <= 1 && result.surfaceGaps.bodyToFooter <= 1, `${label}: schedule editor has visible gaps between its header, body, or footer: ${JSON.stringify(result)}`);
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
    const primaryActions = Array.from(document.querySelectorAll(".modsWorkspacePrimaryActions .uiButton"));
    const updateActions = Array.from(document.querySelectorAll(".modsWorkspaceUpdateActions .uiButton"));
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
      primaryActionsShareRow: primaryActions.length < 2 || Math.abs(primaryActions[0].getBoundingClientRect().top - primaryActions[1].getBoundingClientRect().top) <= 1,
      updateActionsShareRow: updateActions.length < 2 || Math.abs(updateActions[0].getBoundingClientRect().top - updateActions[1].getBoundingClientRect().top) <= 1,
      overflowingActions: actions.filter((action) => action.scrollWidth > action.clientWidth + 1).map((action) => action.textContent?.trim() || "unnamed action"),
      coveredActions
    };
  });
  assert(!result.missing, `${label}: mods toolbar surfaces are missing`);
  assert(result.installedTop >= result.toolbarBottom, `${label}: installed mods overlaps the toolbar (${result.installedTop} < ${result.toolbarBottom})`);
  assert(result.primaryActionsShareRow && result.updateActionsShareRow, `${label}: mods toolbar actions did not retain the compact two-column layout: ${JSON.stringify(result)}`);
  assert(result.overflowingActions.length === 0, `${label}: mods toolbar labels overflow their actions: ${JSON.stringify(result.overflowingActions)}`);
  assert(result.coveredActions.length === 0, `${label}: mods toolbar actions are covered: ${JSON.stringify(result.coveredActions)}`);
}

async function assertDemoSuppressesNodeUpdateToast(page, label) {
  await page.waitForTimeout(100);
  assert(await page.getByText("Multiple nodes have an update available.", { exact: true }).count() === 0, `${label}: demo mode rendered a node update notification`);
}

async function assertNodeDetailsOpeningPosition(page, label) {
  const result = await page.evaluate(() => {
    const header = document.querySelector(".nodeDrawerHeader");
    const close = document.querySelector(".nodeDrawerClose");
    if (!(header instanceof HTMLElement) || !(close instanceof HTMLElement)) return { missing: true };
    const headerRect = header.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    return {
      missing: false,
      documentTop: document.scrollingElement?.scrollTop ?? -1,
      header: { top: headerRect.top, bottom: headerRect.bottom },
      close: { top: closeRect.top, bottom: closeRect.bottom },
      viewportHeight: innerHeight
    };
  });
  assert(!result.missing, `${label}: node drawer header is missing`);
  assert(result.documentTop <= 1 && result.header.top >= 0 && result.header.bottom <= result.viewportHeight && result.close.top >= 0 && result.close.bottom <= result.viewportHeight, `${label}: node details did not open at its visible top: ${JSON.stringify(result)}`);
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

async function assertTabletShellContainment(page, title, label) {
  await openPage(page, title);
  const result = await page.evaluate(() => {
    const shell = document.querySelector(".appShell");
    const sidebar = document.querySelector(".sidebar");
    const workspace = document.querySelector(".workspace");
    const owner = document.scrollingElement;
    if (!(shell instanceof HTMLElement) || !(sidebar instanceof HTMLElement) || !(workspace instanceof HTMLElement) || !(owner instanceof HTMLElement)) return { missing: true };
    const shellRect = shell.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    return {
      missing: false,
      viewportHeight: innerHeight,
      documentHeight: owner.scrollHeight,
      documentViewportHeight: owner.clientHeight,
      documentTop: owner.scrollTop,
      shellHeight: shellRect.height,
      shellOverflow: getComputedStyle(shell).overflow,
      sidebarBottom: sidebarRect.bottom,
      sidebarScrollable: sidebar.scrollHeight > sidebar.clientHeight + 1,
      workspaceTop: workspaceRect.top,
      workspaceBottom: workspaceRect.bottom,
      workspaceOverflowY: getComputedStyle(workspace).overflowY
    };
  });
  assert(!result.missing, `${label}: tablet shell surfaces are missing`);
  assert(Math.abs(result.shellHeight - result.viewportHeight) <= 1, `${label}: shell does not match the visual viewport: ${JSON.stringify(result)}`);
  assert(result.documentHeight <= result.documentViewportHeight + 1 && result.documentTop === 0, `${label}: shell leaks into document scrolling: ${JSON.stringify(result)}`);
  assert(result.shellOverflow === "hidden", `${label}: shell does not contain tablet scrolling: ${JSON.stringify(result)}`);
  assert(!result.sidebarScrollable, `${label}: navigation became independently scrollable: ${JSON.stringify(result)}`);
  assert(Math.abs(result.workspaceTop - result.sidebarBottom) <= 1 && result.workspaceBottom <= result.viewportHeight + 1, `${label}: workspace does not use the viewport remainder: ${JSON.stringify(result)}`);
  assert(["auto", "scroll"].includes(result.workspaceOverflowY), `${label}: workspace is not the tablet scroll owner: ${JSON.stringify(result)}`);
}

async function assertTabletNavigationContainment(page, label) {
  await page.getByRole("button", { name: "Expand navigation" }).click();
  const result = await page.evaluate(() => {
    const shell = document.querySelector(".appShell");
    const sidebar = document.querySelector(".sidebar");
    const owner = document.scrollingElement;
    if (!(shell instanceof HTMLElement) || !(sidebar instanceof HTMLElement) || !(owner instanceof HTMLElement)) return { missing: true };
    return {
      missing: false,
      documentHeight: owner.scrollHeight,
      documentViewportHeight: owner.clientHeight,
      shellHeight: shell.getBoundingClientRect().height,
      sidebarBottom: sidebar.getBoundingClientRect().bottom,
      sidebarScrollable: sidebar.scrollHeight > sidebar.clientHeight + 1,
      viewportHeight: innerHeight
    };
  });
  assert(!result.missing, `${label}: expanded navigation surfaces are missing`);
  assert(result.documentHeight <= result.documentViewportHeight + 1, `${label}: expanded navigation made the document scrollable: ${JSON.stringify(result)}`);
  assert(Math.abs(result.shellHeight - result.viewportHeight) <= 1 && result.sidebarBottom <= result.viewportHeight + 1, `${label}: expanded navigation left the viewport: ${JSON.stringify(result)}`);
  assert(!result.sidebarScrollable, `${label}: expanded navigation became independently scrollable: ${JSON.stringify(result)}`);
  await page.getByRole("button", { name: "Collapse navigation" }).click();
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

async function assertSettingsModuleDescriptionsVisible(page, label) {
  await page.getByRole("tab", { name: /Modules/ }).click();
  const result = await page.locator(".settingsModuleCard").evaluateAll((cards) => cards.map((card) => {
    const description = card.querySelector(".settingsModuleCardCopy > span");
    if (!(description instanceof HTMLElement)) return { missing: true };
    const cardRect = card.getBoundingClientRect();
    const descriptionRect = description.getBoundingClientRect();
    const cardStyle = getComputedStyle(card);
    return {
      missing: false,
      label: card.getAttribute("aria-label"),
      clippedText: description.scrollHeight > description.clientHeight + 1,
      leavesCard: descriptionRect.bottom > cardRect.bottom - Number.parseFloat(cardStyle.paddingBottom) + 1
    };
  }));
  assert(result.every((card) => !card.missing), `${label}: module descriptions are missing`);
  assert(result.every((card) => !card.clippedText && !card.leavesCard), `${label}: module descriptions are clipped: ${JSON.stringify(result)}`);
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

async function assertPageRestoresOnReload(page, title, storedPage, contentSelector, label) {
  await openPage(page, title);
  await page.locator(contentSelector).waitFor();
  const navigationItem = page.locator(`.sideNav button[title="Open ${title}"]`);
  assert.equal(await navigationItem.getAttribute("aria-current"), "page", `${label}: sidebar does not mark ${title} active before reload`);

  const readStoredPage = () => page.evaluate(() => {
    const raw = localStorage.getItem("serversentinel-active-page");
    return raw ? JSON.parse(raw).value : null;
  });
  assert.equal(await readStoredPage(), storedPage, `${label}: ${title} was not persisted before reload`);

  let releaseAppCatalog;
  let appCatalogRequested;
  const appCatalogGate = new Promise((resolve) => { releaseAppCatalog = resolve; });
  const appCatalogRequest = new Promise((resolve) => { appCatalogRequested = resolve; });
  const delayAppCatalog = async (route) => {
    appCatalogRequested();
    await appCatalogGate;
    await route.continue();
  };
  await page.route("**/api/app", delayAppCatalog);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".appShell").waitFor();
    await appCatalogRequest;
    await page.locator(`.workspacePage-${storedPage}`).waitFor();
    assert.equal(await readStoredPage(), storedPage, `${label}: bootstrap overwrote the stored ${title} page`);
    if (storedPage === "schedule") {
      await page.locator(".applicationLoadingSkeleton--schedule").waitFor();
      assert.equal(await page.locator(".schedulePage").count(), 0, `${label}: schedules rendered before module access resolved`);
    }
    releaseAppCatalog();
    await page.locator(contentSelector).waitFor();
    assert.equal(await navigationItem.getAttribute("aria-current"), "page", `${label}: sidebar lost the active ${title} state after restoration`);
    assert.equal(await readStoredPage(), storedPage, `${label}: restored ${title} changed its stored page value`);
  } finally {
    releaseAppCatalog();
    await page.unroute("**/api/app", delayAppCatalog);
  }
}

async function runDesktopMapAndRestorationProfile() {
  const label = "Chromium desktop 1440x1000";
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "reduce"
    });
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem("serversentinel-theme", "light"));
    await signInThroughForm(page, baseUrl);
    await page.locator('.sideNav button[title="Open schedules"]').waitFor({ state: "visible" });

    await assertPageRestoresOnReload(page, "schedules", "schedule", ".schedulePage", `${label} schedules`);
    await assertPageRestoresOnReload(page, "files", "files", ".filesPage", `${label} files`);
    await openPage(page, "players");
    await page.getByRole("group", { name: "Players shown on map" }).getByRole("button", { name: "All time", exact: true }).click();
    await assertPlayerMarkerAnchorsAcrossTransforms(page, `${label} players`, {
      requirePingLabels: true,
      exerciseScopeSwitch: true
    });

    await context.close();
    console.log(`mobile smoke passed: ${label}`);
  } finally {
    if (browser) await browser.close();
  }
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
    await signInThroughForm(page, baseUrl, () => assertTargets(page, [".authPanel .uiButton"], `${label} sign in`));

    await assertDemoSuppressesNodeUpdateToast(page, label);

    assertNativeScrollShell(await shellMetrics(page), `${label} initial`);
    await assertOverviewDensity(page, profile, label);
    await assertNavigationOverlay(page, label);
    await assertTargets(page, [".brandBlock .iconButton", ".activeServerStrip .runtimeControlButton", ".activeServerStrip .refreshStatusButton"], label);
    await assertFloatingSurfaces(page, label);
    await assertPlayerClusterPopupDismisses(page, `${label} players`);

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
    await assertTargets(page, [".modsWorkspaceIdentity", ".modsWorkspaceUpdate .modsUpdateAction"], `${label} mods`);
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
    await assertTargets(page, [".scheduleActionMenuTrigger", ".scheduledRunDetailsButton"], `${label} schedules`);
    await assertScheduleActionMenuVisible(page, `${label} schedule row`);
    const scheduleTrigger = page.getByRole("button", { name: "Add schedule", exact: true });
    await scheduleTrigger.click();
    await page.getByRole("dialog").waitFor();
    await assertEditableFontSizes(page, `${label} schedule dialog`);
    await assertTargets(page, [".scheduleModalPanel .modalCloseButton", ".scheduleModalFooterActions .uiButton"], `${label} schedule dialog`);
    await assertDialogScrollLock(page, ".scheduleModalBackdrop", ".scheduleModalPanel .scheduleEditBody", `${label} schedule dialog`);
    await assertScheduleEditorLayout(page, `${label} schedule dialog`);
    await page.keyboard.press("Escape");
    await page.locator(".scheduleModalPanel").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Add schedule", null, { timeout: 2_000 });

    await openPage(page, "nodes");
    const nodeDetails = page.getByRole("button", { name: "Details", exact: true }).first();
    await nodeDetails.click();
    await page.locator(".nodeDetailsDrawer").waitFor();
    await assertNodeDetailsOpeningPosition(page, `${label} node drawer`);
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

async function runTabletProfile() {
  let browser;
  const label = "WebKit iPad landscape 1024x768";
  try {
    browser = await launchBrowser(webkit);
    const context = await browser.newContext({
      ...devices["iPad (gen 7) landscape"],
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "reduce"
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("serversentinel-theme", "light");
      localStorage.setItem("serversentinel-active-page", "files");
    });
    await signInThroughForm(page, baseUrl);
    await assertTabletNavigationContainment(page, label);

    for (const title of ["overview", "files", "mods", "schedules", "properties", "nodes", "settings", "console"]) {
      await assertTabletShellContainment(page, title, `${label} ${title}`);
    }
    await openPage(page, "settings");
    await assertSettingsModuleDescriptionsVisible(page, `${label} settings modules`);

    await context.close();
    console.log(`mobile smoke passed: ${label}`);
  } finally {
    if (browser) await browser.close();
  }
}

try {
  await runDesktopMapAndRestorationProfile();
  await runTabletProfile();
  await assertConfiguredPlayerAddressEditor();
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
