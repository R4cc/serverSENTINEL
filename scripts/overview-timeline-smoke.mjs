import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = await mkdtemp(join(tmpdir(), "serversentinel-overview-smoke-"));
const port = Number(process.env.SERVERSENTINEL_OVERVIEW_SMOKE_PORT || 4187);
const baseUrl = `http://127.0.0.1:${port}`;
const fixedNow = new Date("2026-07-24T12:00:00.000Z");
const liveFutureRatio = 0.1;
const rangeSpans = new Map([
  ["5m", 5 * 60_000],
  ["15m", 15 * 60_000],
  ["1h", 60 * 60_000],
  ["3h", 3 * 60 * 60_000],
  ["6h", 6 * 60 * 60_000],
  ["24h", 24 * 60 * 60_000]
]);

let server;
let browser;
let serverOutput = "";

function assertNear(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, received ${actual}`);
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Demo server stopped before it became ready.\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { "X-Requested-With": "XMLHttpRequest" }
      });
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for the demo server at ${baseUrl}.\n${serverOutput}`);
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
  const values = await page.locator(".serverTimelinePlayerAxis time").evaluateAll((elements) => (
    elements.map((element) => element.getAttribute("datetime"))
  ));
  assert.equal(values.length, 7, `Expected seven timeline ticks, received ${values.length}`);
  assert(values.every(Boolean), `Timeline ticks are missing datetime values: ${JSON.stringify(values)}`);
  return {
    from: Date.parse(values[0]),
    to: Date.parse(values.at(-1))
  };
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
  assertNear(window.to, await page.evaluate(() => Date.now()) + expectedSpan * liveFutureRatio, 1_000, `${label} live range has incorrect future padding`);
  return window;
}

async function assertScenarioData(page) {
  const identityNames = await page.locator(".serverTimelinePlayerIdentity strong").allTextContents();
  for (const player of ["MarathonSteve", "RejoinRiley", "BlinkAlex"]) {
    assert(identityNames.includes(player), `${player} is missing from the rendered player timeline`);
  }

  const timelineLabels = (await page.locator(".serverTimelinePlayerChart svg text").allTextContents())
    .map((label) => label.trim())
    .filter(Boolean);
  assert(timelineLabels.includes("≥ 24h 0m"), `The 24-hour session label is missing: ${JSON.stringify(timelineLabels)}`);
  assert(timelineLabels.includes("54m active"), `The grouped reconnect duration is missing: ${JSON.stringify(timelineLabels)}`);
  assert(timelineLabels.includes("<1m"), `The instant session label is missing: ${JSON.stringify(timelineLabels)}`);

  const eventsText = await page.locator(".eventsPanel").innerText();
  assert(eventsText.includes("Reconnected") && eventsText.includes("RejoinRiley") && eventsText.includes("Offline for 7 seconds"), "The reconnect event is not summarized correctly");
  assert(eventsText.includes("BlinkAlex") && eventsText.includes("Joined") && eventsText.includes("Left"), "The instant join/leave events are not both visible");
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
    const stage = document.querySelector(".serverTimelineAnnotationStage");
    const visualization = document.querySelector(".serverTimelineVisualization");
    return {
      stage: stage?.getBoundingClientRect().height ?? 0,
      visualization: visualization?.getBoundingClientRect().height ?? 0
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
  assertNear(returned.to, await page.evaluate(() => Date.now()) + rangeSpans.get("1h") * liveFutureRatio, 1_000, "Later navigation did not return to the live boundary");

  const scroller = page.locator(".serverTimelinePlayerScroller");
  const box = await scroller.boundingBox();
  assert(box && box.width > 500, `Player timeline is too narrow to exercise dragging: ${JSON.stringify(box)}`);
  const beforeHeights = await timelineHeights(page);
  const startX = box.x + box.width * 0.62;
  const startY = box.y + Math.min(90, box.height / 2);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + Math.min(160, box.width * 0.15), startY, { steps: 8 });
  const duringHeights = await timelineHeights(page);
  assertNear(duringHeights.stage, beforeHeights.stage, 1, "Annotation stage moved during timeline drag");
  assertNear(duringHeights.visualization, beforeHeights.visualization, 1, "Timeline geometry moved during drag");
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector(".serverTimelineCustomRange")?.textContent?.trim() === "Custom");
  assert.equal((await page.locator(".serverTimelineMode").innerText()).trim(), "Historical", "Dragging did not enter historical mode");
  const dragged = await timelineWindow(page);
  assert(dragged.to < returned.to, "Dragging right did not pan the timeline into history");

  await page.getByRole("button", { name: "Jump to now", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".serverTimelineMode")?.textContent?.trim() === "Live");
  const liveBeforeZoom = await timelineWindow(page);
  const liveScrollerBox = await scroller.boundingBox();
  assert(liveScrollerBox, "Player timeline disappeared before wheel zoom");
  await scroller.dispatchEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: liveScrollerBox.x + liveScrollerBox.width * 0.7,
    clientY: liveScrollerBox.y + 80,
    ctrlKey: true,
    deltaY: -360
  });
  await page.waitForFunction(() => document.querySelector(".serverTimelineCustomRange")?.textContent?.trim() === "Custom");
  const zoomed = await timelineWindow(page);
  assert(zoomed.to - zoomed.from < liveBeforeZoom.to - liveBeforeZoom.from, "Ctrl+wheel did not zoom the player timeline");

  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await page.getByRole("button", { name: "Jump to now", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".serverTimelineMode")?.textContent?.trim() === "Live");

  const scrollMetrics = await scroller.evaluate((element) => ({
    top: element.scrollTop,
    height: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  assert(scrollMetrics.scrollHeight > scrollMetrics.height, "Demo player timeline is not tall enough to exercise scrolling");
  const scrollBox = await scroller.boundingBox();
  assert(scrollBox, "Player timeline disappeared before scrolling");
  await scroller.hover();
  const scrollBefore = await page.evaluate(({ x, y }) => ({
    documentTop: document.scrollingElement?.scrollTop ?? 0,
    scrollerTop: document.querySelector(".serverTimelinePlayerScroller")?.scrollTop ?? 0,
    hitClass: document.elementFromPoint(x, y)?.className ?? ""
  }), { x: scrollBox.x + scrollBox.width / 2, y: scrollBox.y + scrollBox.height / 2 });
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(100);
  const scrollAfter = await page.evaluate(() => ({
    documentTop: document.scrollingElement?.scrollTop ?? 0,
    scrollerTop: document.querySelector(".serverTimelinePlayerScroller")?.scrollTop ?? 0
  }));
  assert(scrollAfter.scrollerTop > scrollBefore.scrollerTop, `Wheel did not scroll the player timeline: ${JSON.stringify({ scrollMetrics, scrollBefore, scrollAfter })}`);
}

async function assertDesktop(page) {
  const panel = await waitForTimeline(page);
  assert.equal(await panel.getAttribute("aria-busy"), "false");
  await assertScenarioData(page);
  await assertRosterDisclosure(page);

  for (const label of rangeSpans.keys()) await selectRange(page, label);
  const twentyFourHourLabels = await page.locator(".serverTimelinePlayerChart svg text").allTextContents();
  assert(twentyFourHourLabels.some((label) => label.trim() === "≥ 24h 0m"), "Marathon session disappeared in the 24-hour range");

  await assertTimelineNavigation(page);
  const overflow = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  assert(overflow.documentWidth <= overflow.viewportWidth, `Overview has horizontal page overflow: ${JSON.stringify(overflow)}`);
}

async function assertMobile(page) {
  const resourcePanel = page.locator(".resourcePanel");
  await resourcePanel.getByRole("heading", { name: "Resource Usage", exact: true }).waitFor();
  for (const label of ["1m", "5m", "15m", "1h", "All"]) {
    const button = resourcePanel.getByRole("button", { name: label, exact: true });
    await button.click();
    assert.equal(await button.getAttribute("aria-pressed"), "true", `Mobile resource range ${label} did not activate`);
  }

  const mobileMetrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    rosterTargetHeight: document.querySelector(".activePlayerRosterToggle")?.getBoundingClientRect().height ?? 0
  }));
  assert(mobileMetrics.documentWidth <= mobileMetrics.viewportWidth, `Mobile Overview has horizontal page overflow: ${JSON.stringify(mobileMetrics)}`);
  assert(mobileMetrics.rosterTargetHeight >= 44, `Mobile roster disclosure is smaller than 44px: ${JSON.stringify(mobileMetrics)}`);
}

async function createOverviewPage(context, viewport) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  await page.clock.setFixedTime(fixedNow);
  await page.addInitScript(() => {
    localStorage.setItem("serversentinel-active-page", "overview");
    localStorage.setItem("serversentinel-demo-mode", "true");
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
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  try {
    await page.locator(".overviewDashboardGrid").waitFor({ timeout: 10_000 });
  } catch {
    const bodyText = (await page.locator("body").innerText()).slice(0, 1_000);
    throw new Error(`Overview did not mount at ${page.url()}. Browser errors: ${JSON.stringify(browserErrors)}. Body: ${bodyText}`);
  }
  return { page, browserErrors };
}

try {
  server = spawn(process.execPath, [join(repositoryRoot, "server", "dist", "index.js")], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      LOG_LEVEL: "warn",
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

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    reducedMotion: "reduce"
  });
  const loginResponse = await context.request.post(`${baseUrl}/api/auth/login`, {
    headers: { "X-Requested-With": "XMLHttpRequest" },
    data: { username: "demo", password: "demo" }
  });
  if (!loginResponse.ok()) throw new Error(`Demo startup is broken: demo / demo could not sign in. ${await loginResponse.text()}`);

  const desktop = await createOverviewPage(context, { width: 1440, height: 1000 });
  await assertDesktop(desktop.page);
  assert.deepEqual(desktop.browserErrors, [], `Desktop browser errors: ${desktop.browserErrors.join("\n")}`);
  await desktop.page.close();

  const mobile = await createOverviewPage(context, { width: 390, height: 844 });
  await assertMobile(mobile.page);
  assert.deepEqual(mobile.browserErrors, [], `Mobile browser errors: ${mobile.browserErrors.join("\n")}`);
  await mobile.page.close();

  console.log("Overview timeline smoke passed: realistic sessions, all ranges, pan, drag, zoom, scroll, roster, and mobile layout.");
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => server.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 5_000))
    ]);
  }
  await rm(dataDirectory, { recursive: true, force: true });
}
