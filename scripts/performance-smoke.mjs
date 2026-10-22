import assert from "node:assert/strict";
import { chromium } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

// Guard first-load layout and lazy payloads with real production assets. Lighthouse
// provides the score; these assertions catch the specific regressions behind it.
const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-performance-" });
function observeStartup({ theme, page }) {
  localStorage.setItem("serversentinel-theme", theme);
  localStorage.setItem("serversentinel-signed-in", "true");
  localStorage.setItem("serversentinel-active-page", JSON.stringify({ value: page, savedAt: Date.now() }));
  window.performanceShifts = [];
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.performanceShifts.push(entry.value);
  }).observe({ type: "layout-shift", buffered: true });
}
let browser;
try {
  browser = await launchBrowser(chromium);
  for (const width of [1350, 1024, 412]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 940 }, reducedMotion: "reduce" });
    await signInThroughApi(context, harness.baseUrl);
    await context.addInitScript(observeStartup, { theme, page: "overview" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const requests = [];
    page.on("request", request => requests.push(request.url()));
    await page.goto(harness.baseUrl);
    await page.locator(".modUpdatesListItem").first().waitFor();
    if (width > 980) await page.locator(".serverTimelinePlayerChart:not(.serverTimelinePlayerEmpty)").waitFor();
    await page.evaluate(() => document.fonts.ready);
    // Allow async module bridges and chart sizing to commit, before idle prefetch.
    await page.waitForTimeout(1000);
    const cls = await page.evaluate(() => window.performanceShifts.reduce((total, value) => total + value, 0));
    assert(cls < 0.03, `${width}/${theme}: Overview shifted during startup (${cls})`);
    assert(!requests.some(url => /\/(?:ModsPage|ModHistoryPage|OnboardingFlow|ExportModal|ImportModal|codemirror-vendor|xterm-vendor)[-.]/.test(url)), "Overview fetched an unrelated editor or dialog");
    const unrelatedCss = requests.filter(url => /\.css(?:\?|$)/.test(url) && !/\/(?:index|ServerOverviewTab)-/.test(url));
    assert.deepEqual(unrelatedCss, [], "Overview fetched unrelated feature CSS");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Overview overflows horizontally");
    assert.deepEqual(errors, []);
    console.log(`Performance smoke passed: ${width}px ${theme}, CLS ${cls.toFixed(4)}`);
    await context.close();
  }
  // A cold Nodes restore must not mount below the application skeleton or load
  // the event table. Delay the snapshot to expose that race.
  const context = await browser.newContext({ viewport: { width: 412, height: 940 }, reducedMotion: "reduce" });
  await signInThroughApi(context, harness.baseUrl);
  await context.addInitScript(observeStartup, { theme: "dark", page: "nodes" });
  const page = await context.newPage();
  const requests = [];
  page.on("request", request => requests.push(request.url()));
  await page.route("**/api/app", async route => {
    await new Promise(resolve => setTimeout(resolve, 200));
    await route.continue();
  });
  await page.goto(harness.baseUrl);
  await page.locator(".nodeListItem").first().waitFor();
  await page.waitForTimeout(1000);
  const cls = await page.evaluate(() => window.performanceShifts.reduce((total, value) => total + value, 0));
  assert(cls < 0.03, `Cold Nodes startup shifted (${cls})`);
  assert(!requests.some(url => /\/(?:RecentEventsPanel|tableFeatures)-/.test(url)), "Nodes downloaded the event table");
  console.log(`Performance smoke passed: cold Nodes, CLS ${cls.toFixed(4)}`);
  await context.close();
} finally {
  await browser?.close();
  await harness.stop();
}
