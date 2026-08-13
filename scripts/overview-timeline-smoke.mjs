import assert from "node:assert/strict";
import { chromium } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

const harness = await startDemoHarness({
  dataDirectoryPrefix: "serversentinel-overview-smoke-",
  port: Number(process.env.SERVERSENTINEL_OVERVIEW_SMOKE_PORT || 4187)
});
const { baseUrl } = harness;
const fixedNow = new Date("2026-07-24T12:00:00.000Z");
const rangeSpans = new Map([
  ["5m", 5 * 60_000],
  ["15m", 15 * 60_000],
  ["1h", 60 * 60_000],
  ["3h", 3 * 60 * 60_000],
  ["6h", 6 * 60 * 60_000],
  ["24h", 24 * 60 * 60_000],
  ["7d", 7 * 24 * 60 * 60_000]
]);

let browser;

function assertNear(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, received ${actual}`);
}

async function waitForTimeline(page) {
  const panel = page.locator('.serverTimelinePanel[aria-busy="false"]');
  await panel.getByRole("heading", { name: "Server Timeline", exact: true }).waitFor();
  await page.waitForFunction(() => {
    const charts = document.querySelectorAll('.serverTimelinePanel[aria-busy="false"] .serverTimelineEChart');
    return charts.length > 0 && [...charts].every((chart) => chart.querySelector("svg"));
  });
  return panel;
}

async function timelineWindow(page) {
  return page.locator(".serverTimelinePlayers").evaluate((element) => ({
    from: Number(element.getAttribute("data-viewport-from")),
    to: Number(element.getAttribute("data-viewport-to"))
  }));
}

async function selectRange(page, label) {
  const range = page.getByRole("group", { name: "Timeline range" });
  const button = range.getByRole("button", { name: label, exact: true });
  await button.click();
  await page.waitForFunction((selectedLabel) => {
    const controls = document.querySelector('.serverTimelineRangeControls[aria-label="Timeline range"]');
    const selected = [...(controls?.querySelectorAll("button") ?? [])]
      .find((candidate) => candidate.textContent?.trim() === selectedLabel);
    const panel = document.querySelector(".serverTimelinePanel");
    return selected?.getAttribute("aria-pressed") === "true" && panel?.getAttribute("aria-busy") === "false";
  }, label);
  const window = await timelineWindow(page);
  const expectedSpan = rangeSpans.get(label);
  assertNear(window.to - window.from, expectedSpan, 2, `${label} range span is incorrect`);
  assertNear(window.to, await page.evaluate(() => Date.now()), 1_000, `${label} live range does not end at the current time`);
  return window;
}

async function assertScenarioData(page) {
  const chart = page.locator(".serverTimelinePlayerChart .serverTimelineEChart");
  assert.equal(await chart.count(), 1, "Player activity should use exactly one ECharts instance");
  const box = await chart.boundingBox();
  assert(box, "Unified player timeline is missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let index = 0; index < 60; index += 1) await page.mouse.wheel(0, -600);
  const renderedLabels = new Set();
  for (let index = 0; index < 240; index += 1) {
    for (const label of await chart.locator("svg text").allTextContents()) {
      const value = label.trim();
      if (value) renderedLabels.add(value);
    }
    if (["25h 0m", "24m", "30m", "<1m"].every((label) => renderedLabels.has(label))) break;
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(15);
  }
  const timelineLabels = [...renderedLabels];
  assert(!timelineLabels.some((label) => label.toLowerCase().includes("alex")), `A removed fixed identity is still rendered: ${JSON.stringify(timelineLabels)}`);
  assert(timelineLabels.includes("25h 0m"), `The exact multi-day session label is missing: ${JSON.stringify(timelineLabels)}`);
  assert(timelineLabels.includes("24m") && timelineLabels.includes("30m"), `Completed and current reconnect sessions are not rendered separately: ${JSON.stringify(timelineLabels)}`);
  assert(!timelineLabels.includes("54m active"), `Completed and current reconnect sessions were merged into one state: ${JSON.stringify(timelineLabels)}`);
  assert(timelineLabels.includes("<1m"), `The instant session label is missing: ${JSON.stringify(timelineLabels)}`);
  const ariaDescription = await chart.getAttribute("aria-label");
  assert(ariaDescription?.includes("Player session timeline") && ariaDescription.includes("Online now"), `Player timeline accessibility description is incomplete: ${ariaDescription}`);
  for (let index = 0; index < 60; index += 1) await page.mouse.wheel(0, -600);

  const eventsText = await page.locator(".eventsPanel").innerText();
  assert(eventsText.includes("Reconnected") && eventsText.includes("Offline for 7 seconds"), `The reconnect event is not summarized correctly: ${eventsText}`);
  const joinedSubjects = await page.locator(".eventsPanel .eventKind--player_joined .eventSubject").allTextContents();
  const leftSubjects = await page.locator(".eventsPanel .eventKind--player_left .eventSubject").allTextContents();
  assert(joinedSubjects.some((subject) => leftSubjects.includes(subject)), "The instant join/leave events do not share a generated player identity");
  assert(!eventsText.toLowerCase().includes("alex"), `A removed fixed identity is still rendered in recent events: ${eventsText}`);
}

async function playerSessionSegments(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".serverTimelinePanel");
    if (!panel) return [];
    const style = getComputedStyle(panel);
    const onlineColor = style.getPropertyValue("--timeline-join").trim().toLowerCase();
    const offlineColor = style.getPropertyValue("--timeline-leave").trim().toLowerCase();
    return [...document.querySelectorAll(".serverTimelinePlayerChart svg path")].flatMap((path) => {
      const stroke = (path.getAttribute("stroke") ?? "").trim().toLowerCase();
      if (stroke !== onlineColor && stroke !== offlineColor) return [];
      const box = path.getBoundingClientRect();
      if (box.width <= 20 || box.height > 2) return [];
      return [{ tone: stroke === onlineColor ? "online" : "offline", y: box.y, width: box.width }];
    });
  });
}

async function assertPlayerSessionStateColors(page) {
  const chart = page.locator(".serverTimelinePlayerChart .serverTimelineEChart");
  const box = await chart.boundingBox();
  assert(box, "Unified player timeline is missing while checking session colors");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let index = 0; index < 60; index += 1) await page.mouse.wheel(0, -600);

  let liveSegments = [];
  let hasMixedStateLane = false;
  for (let index = 0; index < 240; index += 1) {
    liveSegments = await playerSessionSegments(page);
    const completed = liveSegments.filter((segment) => segment.tone === "offline");
    const current = liveSegments.filter((segment) => segment.tone === "online");
    hasMixedStateLane = completed.some((ended) => current.some((online) => Math.abs(ended.y - online.y) <= 1));
    if (hasMixedStateLane) break;
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(15);
  }
  assert(
    hasMixedStateLane,
    `A player's completed and current sessions do not render as separate offline/online states: ${JSON.stringify(liveSegments)}`
  );

  await selectRange(page, "1h");
  await page.getByRole("button", { name: "Earlier timeline window", exact: true }).click();
  await page.waitForFunction((now) => {
    const players = document.querySelector(".serverTimelinePlayers");
    const panel = document.querySelector(".serverTimelinePanel");
    return Number(players?.getAttribute("data-viewport-to")) < now && panel?.getAttribute("aria-busy") === "false";
  }, fixedNow.getTime());

  const historicalSegments = await playerSessionSegments(page);
  const nowLabels = await page.locator(".serverTimelinePlayerChart svg text").allTextContents();
  assert(!nowLabels.includes("Now"), `The historical viewport still renders a current endpoint: ${JSON.stringify(nowLabels)}`);
  assert(
    historicalSegments.some((segment) => segment.tone === "online"),
    `Open player sessions changed to the offline color after now left the viewport: ${JSON.stringify(historicalSegments)}`
  );

  await page.getByRole("button", { name: "Jump to now", exact: true }).click();
  await selectRange(page, "3h");
}

// The desktop Overview replaced the Active Players card with the timeline, so the
// roster disclosure lives on the player-activity section here and on the standalone
// card only in the chartless mobile layout.
async function assertPlayerSectionDisclosure(page) {
  const section = page.locator(".serverTimelinePlayers");
  const chart = section.locator(".serverTimelinePlayerChart");
  const counts = await section.locator(".serverTimelinePlayerCount").allTextContents();
  assert(counts.some((text) => /\d+ online/.test(text)), `Player activity is missing an online count: ${JSON.stringify(counts)}`);

  const toggle = section.locator(".serverTimelinePlayerToggle");
  assert.equal(await toggle.count(), 1, "The demo roster should overflow the collapsed player section");
  assert.equal((await toggle.innerText()).replace(/\s+/g, " ").trim(), "Show more players ▾", "The collapsed player disclosure promises more than the capped expansion can show");
  const collapsedHeight = (await chart.boundingBox())?.height ?? 0;
  await toggle.click();
  await page.waitForFunction(() => document.querySelector(".serverTimelinePlayerChart")?.classList.contains("is-expanded"));
  const expandedHeight = (await chart.boundingBox())?.height ?? 0;
  assert(expandedHeight > collapsedHeight, `Expanding the player section did not grow it: ${collapsedHeight} -> ${expandedHeight}`);
  assert.equal(await section.getByRole("button", { name: /Show fewer/ }).count(), 1, "Expanded player section cannot be collapsed again");
  await toggle.click();
  await page.waitForFunction(() => !document.querySelector(".serverTimelinePlayerChart")?.classList.contains("is-expanded"));
}

async function assertSchedulePopoverIconContrast(page) {
  await selectRange(page, "6h");
  const trigger = page.locator(".timelineAnnotationCluster").filter({
    has: page.locator(".timelineAnnotationClusterIcon.tone-automation, .timelineAnnotationClusterIcon.tone-planned")
  }).first();
  assert(await trigger.count(), "The timeline is missing its schedule marker");
  await trigger.click();

  const glyph = page.locator(".serverTimelineAnnotationPopoverItem:is(.tone-automation, .tone-planned) .serverTimelineAnnotationPopoverGlyph").first();
  await glyph.waitFor();
  const appearance = await glyph.locator("svg").evaluate((icon) => {
    const iconStyles = getComputedStyle(icon);
    const glyphStyles = getComputedStyle(icon.parentElement);
    return {
      color: glyphStyles.color,
      fill: iconStyles.fill,
      stroke: iconStyles.stroke
    };
  });
  assert.equal(appearance.fill, "none", `Schedule popover icon received a solid fill: ${JSON.stringify(appearance)}`);
  assert.equal(appearance.stroke, appearance.color, `Schedule popover icon did not inherit the visible schedule color: ${JSON.stringify(appearance)}`);
  assert.notEqual(appearance.stroke, "rgb(0, 0, 0)", `Schedule popover icon rendered black: ${JSON.stringify(appearance)}`);

  await page.getByRole("button", { name: "Close events popover" }).click();
  await page.locator(".serverTimelineAnnotationPopover").waitFor({ state: "detached" });
}

async function assertRosterDisclosure(page) {
  const panel = page.locator(".playersPanel");
  const badgeText = (await panel.locator(".uiStatusBadge").innerText()).trim();
  const onlineCount = Number.parseInt(badgeText.split("/")[0].trim(), 10);
  assert(Number.isFinite(onlineCount) && onlineCount >= 10, `Unexpected demo player count: ${badgeText}`);
  assert.equal(await panel.locator(".activePlayer").count(), 8, "Collapsed roster does not show the eight-player preview");

  const expand = panel.locator('.activePlayerRosterToggle[aria-expanded="false"]');
  assert((await expand.innerText()).includes(`Show ${onlineCount - 8} more`), "Roster expansion count is incorrect");
  await expand.click();
  await page.waitForFunction((expected) => document.querySelectorAll(".playersPanel .activePlayer").length === expected, onlineCount);
  assert.equal(await panel.locator(".activePlayer").count(), onlineCount, "Expanded roster does not show every online player");
  await panel.getByRole("button", { name: "Show fewer players", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".playersPanel .activePlayer").length === 8);
}

async function timelineHeights(page) {
  return page.evaluate(() => {
    const stage = document.querySelector(".serverTimelineEventRail");
    const visualization = document.querySelector(".serverTimelineVisualization");
    return {
      stage: stage?.getBoundingClientRect().height ?? 0,
      visualization: visualization?.getBoundingClientRect().height ?? 0
    };
  });
}

async function timelineVisualState(page) {
  return page.evaluate(() => {
    const fingerprint = (values) => values.reduce((hash, value) => {
      for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
      return hash;
    }, 2_166_136_261) >>> 0;
    const pathFingerprint = (chart, seriesOnly = false) => fingerprint(
      [...chart.querySelectorAll("svg path")]
        .map((path) => `${path.getAttribute("d") ?? ""}|${path.getAttribute("transform") ?? ""}`)
        .filter((value) => !seriesOnly || value.length > 100)
    );

    return {
      playerFrom: document.querySelector(".serverTimelinePlayers")?.getAttribute("data-viewport-from") ?? "",
      playerCharts: [...document.querySelectorAll(".serverTimelinePlayerChart")].map((chart) => pathFingerprint(chart)),
      metricBands: [...document.querySelectorAll(".serverTimelineMetricBand")].map((band) => {
        const chart = band.querySelector(".serverTimelineEChart");
        return {
          label: band.querySelector(".serverTimelineMetricBandLabel")?.textContent?.trim() ?? "",
          fingerprint: chart ? pathFingerprint(chart, true) : 0
        };
      })
    };
  });
}

async function assertTimelineNavigation(page) {
  await selectRange(page, "1h");
  const initial = await timelineWindow(page);

  await page.getByRole("button", { name: "Earlier timeline window", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".serverTimelineMode")?.textContent?.trim() === "Historical");
  const earlier = await timelineWindow(page);
  assertNear(earlier.to - initial.to, -30 * 60_000, 2, "Earlier navigation did not pan by half a window");
  assert(await page.getByRole("button", { name: "Later timeline window", exact: true }).isEnabled(), "Later navigation stayed disabled in historical mode");

  await page.getByRole("button", { name: "Later timeline window", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".serverTimelineMode")?.textContent?.trim() === "Live");
  const returned = await timelineWindow(page);
  assertNear(returned.to, await page.evaluate(() => Date.now()), 1_000, "Later navigation did not return to the live boundary");

  const scroller = page.locator(".serverTimelinePlayerChart .serverTimelineEChart");
  const box = await scroller.boundingBox();
  assert(box && box.width > 500, `Player timeline is too narrow to exercise dragging: ${JSON.stringify(box)}`);
  const beforeHorizontalScroll = await timelineVisualState(page);
  await scroller.dispatchEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: box.x + box.width * 0.62,
    clientY: box.y + Math.min(90, box.height / 2),
    deltaX: -160,
    deltaY: 0
  });
  await page.waitForTimeout(100);
  const afterHorizontalScroll = await timelineVisualState(page);
  assert.notEqual(afterHorizontalScroll.playerFrom, beforeHorizontalScroll.playerFrom, "Horizontal scrolling did not pan the player axis");
  assert.deepEqual(
    afterHorizontalScroll.playerCharts.map((fingerprint, index) => fingerprint !== beforeHorizontalScroll.playerCharts[index]),
    beforeHorizontalScroll.playerCharts.map(() => true),
    "Rendered player sessions did not all move during horizontal scrolling"
  );
  assert.deepEqual(
    afterHorizontalScroll.metricBands.map((band, index) => ({
      label: band.label,
      moved: band.fingerprint !== beforeHorizontalScroll.metricBands[index]?.fingerprint
    })),
    beforeHorizontalScroll.metricBands.map((band) => ({ label: band.label, moved: true })),
    "Rendered metric bands did not all move during horizontal scrolling"
  );
  await page.getByRole("button", { name: "Jump to now", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".serverTimelineMode")?.textContent?.trim() === "Live");
  const beforeHeights = await timelineHeights(page);
  const startX = box.x + box.width * 0.62;
  const startY = box.y + Math.min(90, box.height / 2);
  const beforeVisualState = await timelineVisualState(page);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + Math.min(160, box.width * 0.15), startY, { steps: 8 });
  await page.waitForTimeout(50);
  const duringVisualState = await timelineVisualState(page);
  const duringHeights = await timelineHeights(page);
  assertNear(duringHeights.stage, beforeHeights.stage, 1, "Annotation stage moved during timeline drag");
  assertNear(duringHeights.visualization, beforeHeights.visualization, 1, "Timeline geometry moved during drag");
  assert.notEqual(duringVisualState.playerFrom, beforeVisualState.playerFrom, "Player axis did not move during timeline drag");
  assert.deepEqual(
    duringVisualState.playerCharts.map((fingerprint, index) => fingerprint !== beforeVisualState.playerCharts[index]),
    beforeVisualState.playerCharts.map(() => true),
    "Rendered player sessions did not all move with the player axis during timeline drag"
  );
  assert.deepEqual(
    duringVisualState.metricBands.map((band, index) => ({
      label: band.label,
      moved: band.fingerprint !== beforeVisualState.metricBands[index]?.fingerprint
    })),
    beforeVisualState.metricBands.map((band) => ({ label: band.label, moved: true })),
    "Rendered metric bands did not all move with the player axis during timeline drag"
  );
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector(".serverTimelineCustomRange")?.textContent?.trim() === "Custom");
  assert.equal((await page.locator(".serverTimelineMode").innerText()).trim(), "Historical", "Dragging did not enter historical mode");
  const dragged = await timelineWindow(page);
  assert.notDeepEqual(dragged, returned, "Dragging did not move the controlled timeline viewport");

  const beforeMetricDrag = await timelineVisualState(page);
  const cpuChart = page.locator('.serverTimelineMetricBand[aria-label="CPU timeline"] .serverTimelineEChart');
  await cpuChart.scrollIntoViewIfNeeded();
  const cpuBox = await cpuChart.boundingBox();
  assert(cpuBox && cpuBox.width > 500, `CPU timeline is too narrow to exercise dragging: ${JSON.stringify(cpuBox)}`);
  const cpuStartX = cpuBox.x + cpuBox.width * 0.62;
  const cpuStartY = cpuBox.y + cpuBox.height * 0.5;
  await page.mouse.move(cpuStartX, cpuStartY);
  await page.mouse.down();
  await page.mouse.move(cpuStartX + Math.min(120, cpuBox.width * 0.12), cpuStartY, { steps: 8 });
  await page.waitForTimeout(50);
  const duringMetricDrag = await timelineVisualState(page);
  assert.notEqual(duringMetricDrag.playerFrom, beforeMetricDrag.playerFrom, "Player axis did not move during CPU timeline drag");
  assert.deepEqual(
    duringMetricDrag.playerCharts.map((fingerprint, index) => fingerprint !== beforeMetricDrag.playerCharts[index]),
    beforeMetricDrag.playerCharts.map(() => true),
    "Rendered player sessions did not all move during CPU timeline drag"
  );
  assert.deepEqual(
    duringMetricDrag.metricBands.map((band, index) => ({
      label: band.label,
      moved: band.fingerprint !== beforeMetricDrag.metricBands[index]?.fingerprint
    })),
    beforeMetricDrag.metricBands.map((band) => ({ label: band.label, moved: true })),
    "Rendered metric bands did not all move during CPU timeline drag"
  );
  await page.mouse.up();

  await page.getByRole("button", { name: "Jump to now", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".serverTimelineMode")?.textContent?.trim() === "Live");
  const liveBeforeZoom = await timelineWindow(page);
  const liveScrollerBox = await scroller.boundingBox();
  assert(liveScrollerBox, "Player timeline disappeared before wheel zoom");
  await page.mouse.move(liveScrollerBox.x + liveScrollerBox.width * 0.7, liveScrollerBox.y + Math.min(80, liveScrollerBox.height / 2));
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -360);
  await page.keyboard.up("Control");
  await page.waitForFunction(() => document.querySelector(".serverTimelineCustomRange")?.textContent?.trim() === "Custom");
  const zoomed = await timelineWindow(page);
  assert(zoomed.to - zoomed.from < liveBeforeZoom.to - liveBeforeZoom.from, "Ctrl+wheel did not zoom the player timeline");

  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await page.getByRole("button", { name: "Jump to now", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".serverTimelineMode")?.textContent?.trim() === "Live");

  const scrollBox = await scroller.boundingBox();
  assert(scrollBox, "Player timeline disappeared before scrolling");
  await scroller.hover();
  for (let index = 0; index < 60; index += 1) await page.mouse.wheel(0, -600);
  await page.waitForTimeout(120);
  const scrollBefore = await page.evaluate(({ x, y }) => ({
    documentTop: document.scrollingElement?.scrollTop ?? 0,
    labels: [...(document.querySelector(".serverTimelinePlayerChart")?.querySelectorAll("svg text") ?? [])].map((element) => element.textContent?.trim()).filter(Boolean),
    from: document.querySelector(".serverTimelinePlayers")?.getAttribute("data-viewport-from") ?? "",
    hitClass: document.elementFromPoint(x, y)?.className ?? ""
  }), { x: scrollBox.x + scrollBox.width / 2, y: scrollBox.y + scrollBox.height / 2 });
  for (let index = 0; index < 4; index += 1) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(100);
  const scrollAfter = await page.evaluate(() => ({
    documentTop: document.scrollingElement?.scrollTop ?? 0,
    labels: [...(document.querySelector(".serverTimelinePlayerChart")?.querySelectorAll("svg text") ?? [])].map((element) => element.textContent?.trim()).filter(Boolean),
    from: document.querySelector(".serverTimelinePlayers")?.getAttribute("data-viewport-from") ?? ""
  }));
  assert.notDeepEqual(scrollAfter.labels, scrollBefore.labels, `Wheel did not scroll the player timeline rows: ${JSON.stringify({ scrollBefore, scrollAfter })}`);
  assert.equal(scrollAfter.documentTop, scrollBefore.documentTop, "Vertical player-row scrolling moved the page");
  assert.equal(scrollAfter.from, scrollBefore.from, "Vertical player-row scrolling panned the time viewport");
}

async function assertDesktop(page) {
  const panel = await waitForTimeline(page);
  assert.equal(await panel.getAttribute("aria-busy"), "false");
  await assertScenarioData(page);
  await assertPlayerSessionStateColors(page);
  await assertPlayerSectionDisclosure(page);
  await assertSchedulePopoverIconContrast(page);

  for (const label of rangeSpans.keys()) await selectRange(page, label);
  const playerChart = page.locator(".serverTimelinePlayerChart .serverTimelineEChart");
  const playerChartBox = await playerChart.boundingBox();
  assert(playerChartBox, "Player timeline disappeared in the seven-day range");
  await page.mouse.move(playerChartBox.x + playerChartBox.width / 2, playerChartBox.y + playerChartBox.height / 2);
  for (let index = 0; index < 60; index += 1) await page.mouse.wheel(0, -600);
  const retainedRangeLabels = new Set();
  for (let index = 0; index < 100; index += 1) {
    for (const label of await playerChart.locator("svg text").allTextContents()) retainedRangeLabels.add(label.trim());
    if (retainedRangeLabels.has("25h 0m")) break;
    await page.mouse.wheel(0, 600);
  }
  assert(retainedRangeLabels.has("25h 0m"), "Marathon session disappeared in the seven-day range");

  await assertTimelineNavigation(page);
  const overflow = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  assert(overflow.documentWidth <= overflow.viewportWidth, `Overview has horizontal page overflow: ${JSON.stringify(overflow)}`);
}

async function assertMobile(page) {
  // The phone layout is chartless, so the Active Players card and its disclosure are
  // the roster surface here while the timeline owns the desktop layout.
  assert.equal(await page.locator(".serverTimelinePanel").count(), 0, "The phone layout should stay chartless");
  await assertRosterDisclosure(page);

  const mobileMetrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    rosterTargetHeight: document.querySelector(".activePlayerRosterToggle")?.getBoundingClientRect().height ?? 0
  }));
  assert(mobileMetrics.documentWidth <= mobileMetrics.viewportWidth, `Mobile Overview has horizontal page overflow: ${JSON.stringify(mobileMetrics)}`);
  assert(mobileMetrics.rosterTargetHeight >= 44, `Mobile roster disclosure is smaller than 44px: ${JSON.stringify(mobileMetrics)}`);
}

async function assertStorageSummary(page, expectedVisibleTiles) {
  const worldSize = page.locator(".overviewSummary .uiMetricTile").filter({ hasText: "World Size" });
  const spaceRemaining = page.locator(".overviewSummary .storageRemainingTile");
  await worldSize.getByText("7.39 GiB", { exact: true }).waitFor();
  await spaceRemaining.getByText("8 GiB", { exact: true }).waitFor();
  assert.equal(await spaceRemaining.locator(".lucide-triangle-alert").count(), 1, "The demo's near-full storage card is missing its warning icon");
  assert(await spaceRemaining.evaluate((tile) => tile.classList.contains("uiMetricTile--warning")), "The demo's near-full storage card is missing its warning tone");
  assert.equal(await page.locator(".overviewSummary .uiMetricTile").filter({ hasText: "Fabric" }).count(), 0, "The runtime card still occupies an Overview summary slot");
  assert.equal(await page.locator(".overviewSummary .uiMetricTile:visible").count(), expectedVisibleTiles, "The Overview summary has an unexpected visible card count");
  for (const [name, tile] of [["World Size", worldSize], ["Space Remaining", spaceRemaining]]) {
    const typography = await tile.evaluate((element) => {
      const label = element.querySelector(".uiMetricTileLabel");
      const strong = element.querySelector(".uiMetricTileCopy > strong");
      const value = element.querySelector(".summaryByteValue");
      const labelStyle = label ? getComputedStyle(label) : null;
      return {
        labelHeight: label?.getBoundingClientRect().height ?? 0,
        labelLineHeight: Number.parseFloat(labelStyle?.lineHeight ?? "0"),
        strongFontSize: Number.parseFloat(strong ? getComputedStyle(strong).fontSize : "0"),
        valueFontSize: Number.parseFloat(value ? getComputedStyle(value).fontSize : "0")
      };
    });
    assert(Math.abs(typography.valueFontSize - typography.strongFontSize) < 0.1, `${name} value does not use the summary metric type size: ${JSON.stringify(typography)}`);
    assert(typography.labelHeight <= typography.labelLineHeight + 0.5, `${name} label wraps unexpectedly: ${JSON.stringify(typography)}`);
  }
  const geometry = await page.locator(".overviewSummary").evaluate((summary) => ({
    clientWidth: summary.clientWidth,
    scrollWidth: summary.scrollWidth
  }));
  assert(geometry.scrollWidth <= geometry.clientWidth, `The World Size card causes summary overflow: ${JSON.stringify(geometry)}`);
}

async function createOverviewPage(context, viewport, search = "", { forceLiquidGlass = false } = {}) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  await page.clock.setFixedTime(fixedNow);
  if (forceLiquidGlass) {
    await page.addInitScript(() => {
      const nativeMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const result = nativeMatchMedia(query);
        if (query !== "(prefers-reduced-motion: reduce)" && query !== "(prefers-reduced-transparency: reduce)") return result;
        return new Proxy(result, {
          get(target, property) {
            if (property === "matches") return false;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      };
    });
  }
  await page.addInitScript(() => {
    localStorage.setItem("serversentinel-active-page", "overview");
    localStorage.setItem("serversentinel-demo-mode", "true");
    localStorage.setItem("serversentinel-theme", "system");
    localStorage.setItem("serversentinel-date-locale", "en-US");
    localStorage.setItem("serversentinel-number-locale", "en-US");
    localStorage.setItem("serversentinel-display-time-zone", "utc");
    localStorage.removeItem("serversentinel-hidden-recent-event-signatures");
  });
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) browserErrors.push(`response ${response.status()}: ${response.url()}`);
  });
  await page.goto(`${baseUrl}${search}`, { waitUntil: "domcontentloaded" });
  try {
    await page.locator(".overviewDashboardGrid").waitFor({ timeout: 10_000 });
  } catch {
    const bodyText = (await page.locator("body").innerText()).slice(0, 1_000);
    throw new Error(`Overview did not mount at ${page.url()}. Browser errors: ${JSON.stringify(browserErrors)}. Body: ${bodyText}`);
  }
  return { page, browserErrors };
}

async function assertAllPlayersOfflineTransition(page) {
  const section = page.locator(".serverTimelinePlayers");
  const counts = await section.locator(".serverTimelinePlayerCount").allTextContents();
  const online = Number.parseInt(counts.find((value) => value.includes("online")) ?? "0", 10);
  const earlier = Number.parseInt(counts.find((value) => value.includes("earlier")) ?? "0", 10);
  assert(online > 0, `Demo roster has no online players to stop: ${JSON.stringify(counts)}`);

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Stop server", exact: true }).click();
  await page.getByRole("button", { name: "Start", exact: true }).waitFor();
  await page.waitForFunction((expectedEarlier) => {
    const section = document.querySelector(".serverTimelinePlayers");
    const onlineCount = section?.querySelector(".serverTimelinePlayerCount:not(.tone-offline)");
    const earlierCount = section?.querySelector(".serverTimelinePlayerCount.tone-offline")?.textContent ?? "";
    return !onlineCount && Number.parseInt(earlierCount, 10) === expectedEarlier;
  }, online + earlier);
  assert.equal(await section.locator(".serverTimelinePlayerCount.tone-online").count(), 0, "Stopped demo still reports online players");
}

async function assertTimelineResponsiveGeometry(context, viewport) {
  const { page, browserErrors } = await createOverviewPage(context, viewport);
  try {
    await waitForTimeline(page);
    const section = page.locator(".serverTimelinePlayers");
    const chart = section.locator(".serverTimelinePlayerChart");
    const collapsedHeight = (await chart.boundingBox())?.height ?? 0;
    assert(collapsedHeight >= 220 && collapsedHeight <= 270, `Collapsed player chart height jumps at ${viewport.width}px: ${collapsedHeight}`);
    const toggle = section.locator(".serverTimelinePlayerToggle");
    await toggle.click();
    const expandedHeight = (await chart.boundingBox())?.height ?? 0;
    assert(expandedHeight > collapsedHeight, `Player disclosure did not expand at ${viewport.width}px`);
    assert.equal(await section.getByRole("button", { name: /Show fewer/ }).count(), 1);
    const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert(overflow.scrollWidth <= overflow.width, `Timeline creates horizontal overflow at ${viewport.width}px: ${JSON.stringify(overflow)}`);
  } finally {
    assert.deepEqual(browserErrors, [], `Timeline breakpoint browser errors at ${viewport.width}px: ${browserErrors.join("\n")}`);
    await page.close();
  }
}

async function assertServerStripActionsInline(context, viewport) {
  const { page, browserErrors } = await createOverviewPage(context, viewport);
  try {
    const geometry = await page.locator(".activeServerStrip").evaluate((strip) => {
      const left = strip.querySelector(".serverStripLeft")?.getBoundingClientRect();
      const right = strip.querySelector(".serverStripRight")?.getBoundingClientRect();
      const buttonTops = [...strip.querySelectorAll(".serverStripRight button")]
        .map((button) => button.getBoundingClientRect().top);
      return {
        leftTop: left?.top ?? 0,
        rightTop: right?.top ?? 0,
        buttonTops,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth
      };
    });

    assertNear(geometry.rightTop, geometry.leftTop, 2, `Server-strip actions wrap below the server details at ${viewport.width}px`);
    assert(geometry.buttonTops.length > 0, `Server-strip actions are missing at ${viewport.width}px`);
    assert(geometry.buttonTops.every((top) => Math.abs(top - geometry.buttonTops[0]) <= 1), `Server-strip buttons wrap internally at ${viewport.width}px: ${JSON.stringify(geometry)}`);
    assert(geometry.documentWidth <= geometry.viewportWidth, `Server strip causes horizontal overflow at ${viewport.width}px: ${JSON.stringify(geometry)}`);
    assert.deepEqual(browserErrors, [], `Server-strip browser errors at ${viewport.width}px: ${browserErrors.join("\n")}`);
  } finally {
    await page.close();
  }
}

async function assertLiquidGlassAndEditorScrollbar(context) {
  const { page, browserErrors } = await createOverviewPage(context, { width: 1920, height: 1080 }, "", { forceLiquidGlass: true });
  try {
    await page.locator(".activeServerStrip > .uiLiquidGlassEffect").waitFor({ state: "attached", timeout: 10_000 });
    await page.waitForFunction(() => document.querySelectorAll(".activeServerStrip > .uiLiquidGlassEffect > span").length >= 2);
    const geometry = await page.evaluate(() => {
      const read = (selector) => {
        const surface = document.querySelector(selector);
        const effect = surface?.querySelector(":scope > .uiLiquidGlassEffect");
        const overlays = [...(effect?.children ?? [])]
          .filter((child) => ["screen", "overlay"].includes(getComputedStyle(child).mixBlendMode));
        return {
          surfaceRadius: surface ? getComputedStyle(surface).borderRadius : "",
          overlayRadii: overlays.map((overlay) => getComputedStyle(overlay).borderRadius)
        };
      };
      return { sidebar: read(".sidebar"), strip: read(".activeServerStrip") };
    });

    assert.equal(geometry.strip.surfaceRadius, "18px", `Server-strip radius changed: ${JSON.stringify(geometry)}`);
    assert(geometry.strip.overlayRadii.length >= 2 && geometry.strip.overlayRadii.every((radius) => radius === geometry.strip.surfaceRadius), `Server-strip liquid-glass rims do not follow the surface: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.sidebar.surfaceRadius, "0px", `Desktop sidebar radius changed: ${JSON.stringify(geometry)}`);
    assert(geometry.sidebar.overlayRadii.length >= 2 && geometry.sidebar.overlayRadii.every((radius) => radius === geometry.sidebar.surfaceRadius), `Sidebar liquid-glass rims do not follow the surface: ${JSON.stringify(geometry)}`);

    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("rowheader", { name: "config", exact: true }).dblclick();
    await page.getByRole("rowheader", { name: "serversentinel-demo.toml", exact: true }).dblclick();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: "Edit file", exact: true }).click();
    await page.locator(".fileCodeEditor .cm-content").fill(Array.from({ length: 180 }, (_, index) => `setting_${index}=true`).join("\n"));
    const scrollbar = await page.locator(".fileCodeEditor .cm-scroller").evaluate((scroller) => {
      const style = getComputedStyle(scroller);
      return {
        canScroll: scroller.scrollHeight > scroller.clientHeight,
        overflowY: style.overflowY,
        scrollbarColor: style.scrollbarColor,
        scrollbarGutter: style.scrollbarGutter,
        scrollbarWidth: style.scrollbarWidth
      };
    });
    assert(scrollbar.canScroll, `Long file content does not overflow the editor: ${JSON.stringify(scrollbar)}`);
    assert.equal(scrollbar.overflowY, "auto", `File editor no longer owns scrolling: ${JSON.stringify(scrollbar)}`);
    assert(scrollbar.scrollbarGutter.includes("stable"), `File editor does not reserve its scrollbar: ${JSON.stringify(scrollbar)}`);
    assert.equal(scrollbar.scrollbarWidth, "thin", `File editor scrollbar is not visibly styled: ${JSON.stringify(scrollbar)}`);
    assert(scrollbar.scrollbarColor !== "auto", `File editor scrollbar colors are not applied: ${JSON.stringify(scrollbar)}`);
    assert.deepEqual(browserErrors, [], `Liquid-glass/editor browser errors: ${browserErrors.join("\n")}`);
  } finally {
    await page.close();
  }
}

async function assertSupportCardGeometry(context, viewport) {
  const { page, browserErrors } = await createOverviewPage(context, viewport, "?mods-fixture=updates");
  try {
    const metrics = await page.evaluate(() => {
      const mods = document.querySelector(".modUpdatesCard");
      const schedule = document.querySelector(".schedulePanel");
      const updates = [...document.querySelectorAll(".modUpdatesListItem")];
      const scheduleRows = [...document.querySelectorAll(".scheduleUpcomingItem")];
      const remaining = document.querySelector(".modUpdatesRemaining");
      const documentElement = document.documentElement;
      const rect = (element) => element?.getBoundingClientRect();
      const modsRect = rect(mods);
      const scheduleRect = rect(schedule);
      const remainingRect = rect(remaining);
      return {
        viewportWidth: documentElement.clientWidth,
        documentWidth: documentElement.scrollWidth,
        updateCount: updates.length,
        scheduleRowCount: scheduleRows.length,
        scheduleTitle: schedule?.querySelector(".uiPanelHeader h2")?.textContent?.trim() ?? "",
        scheduleHeaderButtonCount: schedule?.querySelectorAll(".uiPanelHeader button").length ?? 0,
        modsUseSharedList: Boolean(mods?.querySelector(":scope > .overviewSupportList")),
        scheduleUsesSharedList: Boolean(schedule?.querySelector(":scope > .overviewSupportList")),
        updateRowsUseSharedStructure: updates.every((row) => row.classList.contains("overviewSupportListItem")),
        scheduleRowsUseSharedStructure: scheduleRows.every((row) => row.classList.contains("overviewSupportListItem")),
        updateRowHeight: rect(updates[0])?.height ?? 0,
        scheduleRowHeight: rect(scheduleRows[0])?.height ?? 0,
        remainingText: remaining?.textContent?.trim() ?? "",
        mods: modsRect ? { top: modsRect.top, bottom: modsRect.bottom, height: modsRect.height } : null,
        schedule: scheduleRect ? { top: scheduleRect.top, bottom: scheduleRect.bottom, height: scheduleRect.height } : null,
        remainingBottom: remainingRect?.bottom ?? 0,
        scheduleOverflow: schedule ? schedule.scrollHeight - schedule.clientHeight : 0
      };
    });

    assert.equal(metrics.updateCount, 4, `Ten updates should render four preview rows at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.remainingText, "6 more updates", `Ten updates should summarize the remaining six at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.scheduleTitle, "Schedules", `Schedule card title is inconsistent at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.scheduleHeaderButtonCount, 0, `Schedule card still has a header action at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    assert(metrics.modsUseSharedList && metrics.scheduleUsesSharedList, `Support cards do not share the direct list structure at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    assert(metrics.updateRowsUseSharedStructure && metrics.scheduleRowsUseSharedStructure, `Support-card rows do not share their structure at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    if (metrics.scheduleRowCount > 0) {
      assertNear(metrics.scheduleRowHeight, metrics.updateRowHeight, 1, `Support-card row heights differ at ${viewport.width}px`);
    }
    assert(metrics.mods && metrics.schedule, `Overview support cards are missing at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    assert(metrics.remainingBottom <= metrics.mods.bottom + 1, `The update disclosure overflows its card at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    assert(metrics.scheduleOverflow <= 1, `The Schedule card clips vertically at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    assert(metrics.documentWidth <= metrics.viewportWidth, `Support cards cause horizontal overflow at ${viewport.width}px: ${JSON.stringify(metrics)}`);

    if (viewport.width >= 981) {
      assertNear(metrics.schedule.top, metrics.mods.top, 1, `Side-by-side support cards do not share a top edge at ${viewport.width}px`);
      assertNear(metrics.schedule.height, metrics.mods.height, 1, `Side-by-side support cards do not have equal heights at ${viewport.width}px`);
    } else {
      assert(metrics.schedule.top >= metrics.mods.bottom, `Stacked support cards overlap at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    }
    assert.deepEqual(browserErrors, [], `Support-card browser errors at ${viewport.width}px: ${browserErrors.join("\n")}`);
  } finally {
    await page.close();
  }
}

async function assertActiveSchedulePresentation(context, viewport) {
  const { page, browserErrors } = await createOverviewPage(context, viewport, "?schedule-fixture=active");
  try {
    if (viewport.width >= 721) await waitForTimeline(page);
    const metrics = await page.evaluate(() => {
      const rail = document.querySelector(".serverTimelineEventRail");
      const track = document.querySelector(".serverTimelineEventRailTrack");
      const range = document.querySelector(".timelineActiveScheduleRun");
      const cardRun = document.querySelector(".scheduleActiveItem");
      const railRect = rail?.getBoundingClientRect();
      const trackRect = track?.getBoundingClientRect();
      const rangeRect = range?.getBoundingClientRect();
      return {
        cardText: cardRun?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        rangeText: range?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        rangeLabel: range?.getAttribute("aria-label") ?? "",
        clippedStart: range?.classList.contains("is-clipped-start") ?? false,
        railHeight: railRect?.height ?? 0,
        trackWidth: trackRect?.width ?? 0,
        rangeWidth: rangeRect?.width ?? 0,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth
      };
    });

    assert(metrics.cardText.includes("Nightly backup"), `Active schedule is missing from the Overview card at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    assert(metrics.cardText.includes("Waiting for 2 players to leave"), `Active schedule status is missing from the Overview card at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    if (viewport.width >= 721) {
      assert(metrics.rangeText.includes("Nightly backup"), `Active schedule range is missing from the Events rail at ${viewport.width}px: ${JSON.stringify(metrics)}`);
      assert(metrics.rangeLabel.includes("still running"), `Active schedule range does not expose its open state at ${viewport.width}px: ${JSON.stringify(metrics)}`);
      assert(metrics.clippedStart, `A run started before the live window is not clipped to its left edge at ${viewport.width}px: ${JSON.stringify(metrics)}`);
      assert(metrics.rangeWidth >= metrics.trackWidth - 2, `The open schedule range does not span the visible window at ${viewport.width}px: ${JSON.stringify(metrics)}`);
      assert(metrics.railHeight > 70, `The Events rail did not reserve room for the active schedule at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    } else {
      assert.equal(metrics.rangeText, "", `Portrait Overview unexpectedly rendered the hidden timeline at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    }
    assert(metrics.documentWidth <= metrics.viewportWidth, `Active schedule UI causes horizontal overflow at ${viewport.width}px: ${JSON.stringify(metrics)}`);

    await page.locator(viewport.width >= 721 ? ".timelineActiveScheduleRun" : ".scheduleActiveItem").click();
    await page.getByRole("heading", { name: "Configured schedules", exact: true }).waitFor();
    assert(await page.locator(".scheduledRunItem.active").evaluate((element) => element === document.activeElement), `Timeline active run did not focus its Schedules entry at ${viewport.width}px`);
    assert.deepEqual(browserErrors, [], `Active-schedule browser errors at ${viewport.width}px: ${browserErrors.join("\n")}`);
  } finally {
    await page.close();
  }
}

try {
  browser = await launchBrowser(chromium);
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    reducedMotion: "reduce"
  });
  await signInThroughApi(context, baseUrl);

  const desktop = await createOverviewPage(context, { width: 1440, height: 1000 });
  await assertStorageSummary(desktop.page, 7);
  await assertDesktop(desktop.page);
  assert(await desktop.page.locator(".appShell").evaluate((element) => element.classList.contains("themeDark")), "Desktop timeline did not start in the requested dark theme");
  await desktop.page.emulateMedia({ colorScheme: "light" });
  await desktop.page.waitForFunction(() => document.querySelector(".appShell")?.classList.contains("themeLight"));
  assert.equal(await desktop.page.locator(".serverTimelinePlayerChart .serverTimelineEChart").count(), 1, "Light-theme switch replaced the unified player chart");
  assert.equal(await desktop.page.locator(".serverTimelinePlayerChart svg").count(), 1, "Light-theme player chart did not retain SVG rendering");
  await assertSchedulePopoverIconContrast(desktop.page);
  await assertAllPlayersOfflineTransition(desktop.page);
  assert.deepEqual(desktop.browserErrors, [], `Desktop browser errors: ${desktop.browserErrors.join("\n")}`);
  await desktop.page.close();

  for (const viewport of [
    { width: 1180, height: 900 },
    { width: 981, height: 844 },
    { width: 980, height: 844 },
    { width: 844, height: 390 }
  ]) await assertTimelineResponsiveGeometry(context, viewport);

  for (const viewport of [
    { width: 721, height: 900 },
    { width: 980, height: 844 },
    { width: 981, height: 844 },
    { width: 1101, height: 900 },
    { width: 1280, height: 900 },
    { width: 1366, height: 900 }
  ]) await assertServerStripActionsInline(context, viewport);

  const mobile = await createOverviewPage(context, { width: 390, height: 844 });
  await assertStorageSummary(mobile.page, 5);
  await assertMobile(mobile.page);
  assert.deepEqual(mobile.browserErrors, [], `Mobile browser errors: ${mobile.browserErrors.join("\n")}`);
  await mobile.page.close();

  for (const viewport of [
    { width: 3840, height: 2160 },
    { width: 1440, height: 1000 },
    { width: 1180, height: 900 },
    { width: 981, height: 844 },
    { width: 980, height: 844 },
    { width: 768, height: 900 },
    { width: 390, height: 844 }
  ]) await assertSupportCardGeometry(context, viewport);

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 }
  ]) await assertActiveSchedulePresentation(context, viewport);

  const materialContext = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    reducedMotion: "no-preference"
  });
  try {
    await signInThroughApi(materialContext, baseUrl);
    await assertLiquidGlassAndEditorScrollbar(materialContext);
  } finally {
    await materialContext.close();
  }

  console.log("Overview timeline smoke passed: dense live and all-offline roster transitions; per-session online/offline colors; all ranges; pan, drag, zoom, exhaustive row scrolling; responsive timeline and server-strip geometry; aligned liquid-glass contours; visible file-editor scrolling; active schedule ranges and card previews; schedule popover contrast; mobile layout; and equal-height support-card geometry through 4K.");
} finally {
  if (browser) await browser.close();
  await harness.stop();
}
