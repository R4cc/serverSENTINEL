import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchBrowser, repositoryRoot, signInThroughApi, startDemoHarness, waitForAppShell } from "./lib/demo-harness.mjs";

const outputDirectory = join(repositoryRoot, "docs", "screenshots");
const fixedTime = new Date("2026-01-15T12:00:00.000Z");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const switzerDirectory = join(repositoryRoot, "web", "src", "assets", "fonts", "switzer");
const [sansRegularData, sansMediumData, sansSemiBoldData, monoFontData] = await Promise.all([
  readFile(join(switzerDirectory, "switzer-400.woff2"), "base64"),
  readFile(join(switzerDirectory, "switzer-500.woff2"), "base64"),
  readFile(join(switzerDirectory, "switzer-600.woff2"), "base64"),
  readFile(join(repositoryRoot, "node_modules", "@fontsource-variable", "cascadia-code", "files", "cascadia-code-latin-wght-normal.woff2"), "base64")
]);

let harness;
let browser;

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: "inherit",
      ...options
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${command} ${args.join(" ")} exited with ${signal || code}`));
    });
  });
}

function runNpm(args) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args]);
  }
  return run(npmCommand, args, { shell: process.platform === "win32" });
}

async function settlePage(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
    for (const element of document.querySelectorAll("*")) {
      if (element.scrollTop) element.scrollTop = 0;
      if (element.scrollLeft) element.scrollLeft = 0;
    }
  });
  await page.waitForTimeout(150);
}

async function capture(page, filename) {
  await settlePage(page);
  await page.screenshot({
    path: join(outputDirectory, filename),
    animations: "disabled",
    caret: "hide"
  });
}

async function installScreenshotFonts(page) {
  await page.addStyleTag({
    content: `
      @font-face {
        font-family: "serverSENTINEL Screenshot Sans";
        font-style: normal;
        font-weight: 400;
        font-display: block;
        src: url("data:font/woff2;base64,${sansRegularData}") format("woff2");
      }
      @font-face {
        font-family: "serverSENTINEL Screenshot Sans";
        font-style: normal;
        font-weight: 500;
        font-display: block;
        src: url("data:font/woff2;base64,${sansMediumData}") format("woff2");
      }
      @font-face {
        font-family: "serverSENTINEL Screenshot Sans";
        font-style: normal;
        font-weight: 600;
        font-display: block;
        src: url("data:font/woff2;base64,${sansSemiBoldData}") format("woff2");
      }
      @font-face {
        font-family: "serverSENTINEL Screenshot Mono";
        font-style: normal;
        font-weight: 200 700;
        font-display: block;
        src: url("data:font/woff2;base64,${monoFontData}") format("woff2-variations");
      }
      :root {
        --font-sans: "serverSENTINEL Screenshot Sans", sans-serif;
        --font-mono: "serverSENTINEL Screenshot Mono", monospace;
      }
    `
  });
  const loadedFontCounts = await page.evaluate(async () => {
    const [regular, medium, semiBold, mono] = await Promise.all([
      document.fonts.load('400 14px "serverSENTINEL Screenshot Sans"', "serverSENTINEL"),
      document.fonts.load('500 14px "serverSENTINEL Screenshot Sans"', "serverSENTINEL"),
      document.fonts.load('600 14px "serverSENTINEL Screenshot Sans"', "serverSENTINEL"),
      document.fonts.load('400 14px "serverSENTINEL Screenshot Mono"', "serverSENTINEL")
    ]);
    return { regular: regular.length, medium: medium.length, semiBold: semiBold.length, mono: mono.length };
  });
  if (!loadedFontCounts.regular || !loadedFontCounts.medium || !loadedFontCounts.semiBold || !loadedFontCounts.mono) {
    throw new Error(`Could not load deterministic screenshot fonts: ${JSON.stringify(loadedFontCounts)}`);
  }
}

async function openPage(page, title, heading) {
  await page.locator(`.sideNav button[title="Open ${title}"]`).click();
  await page.locator(".workspaceHeader").getByRole("heading", { name: heading, exact: true }).waitFor();
}

async function waitForOverviewTimeline(page) {
  const timeline = page.locator('.serverTimelinePanel[aria-busy="false"]');
  await timeline.getByRole("heading", { name: "Server Timeline", exact: true }).waitFor();
  await timeline.locator(".serverTimelineEChart").first().waitFor();
  await page.waitForFunction(() => {
    const charts = document.querySelectorAll('.serverTimelinePanel[aria-busy="false"] .serverTimelineEChart');
    return charts.length > 0 && [...charts].every((chart) => chart.querySelector("svg"));
  });
}

async function waitForConsoleTerminal(page) {
  await page.locator(".minecraftTerminal").waitFor();
  await page.waitForFunction(() => {
    const terminal = document.querySelector(".minecraftTerminal");
    const rows = terminal?.querySelector(".xterm-rows");
    return terminal
      && !terminal.classList.contains("initializing")
      && rows?.textContent?.includes('Done (5.132s)! For help, type "help"');
  });
}

try {
  if (process.env.SERVERSENTINEL_SCREENSHOT_SKIP_BUILD !== "true") {
    await runNpm(["run", "build"]);
  }

  await mkdir(outputDirectory, { recursive: true });

  harness = await startDemoHarness({
    dataDirectoryPrefix: "serversentinel-readme-screenshots-",
    port: Number(process.env.SERVERSENTINEL_SCREENSHOT_PORT || 4173),
    mode: "panel"
  });
  const { baseUrl } = harness;

  browser = await launchBrowser(chromium, {
    executablePath: process.env.SERVERSENTINEL_SCREENSHOT_BROWSER || undefined
  });
  const context = await browser.newContext({
    // The screenshot harness injects repository-pinned fonts as data URLs for
    // deterministic rendering. Keep that test-only behavior isolated here
    // instead of weakening the production Content Security Policy.
    bypassCSP: true,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce"
  });
  await signInThroughApi(context, baseUrl);
  const page = await context.newPage();
  await page.clock.setFixedTime(fixedTime);
  await page.addInitScript(() => {
    localStorage.setItem("serversentinel-theme", "light");
    localStorage.setItem("serversentinel-date-locale", "en-US");
    localStorage.setItem("serversentinel-number-locale", "en-US");
    localStorage.setItem("serversentinel-display-time-zone", "utc");
    localStorage.setItem("serversentinel-active-page", "overview");
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await installScreenshotFonts(page);
  await page.addStyleTag({
    content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }"
  });

  await waitForAppShell(page);

  await page.locator(".workspaceHeader").getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await waitForOverviewTimeline(page);
  await capture(page, "overview.png");

  await openPage(page, "console", "Console");
  await waitForConsoleTerminal(page);
  await capture(page, "console.png");

  await openPage(page, "files", "Files");
  await page.getByRole("table", { name: "Server files" }).waitFor();
  await capture(page, "files.png");

  await page.getByRole("rowheader", { name: "server.properties" }).dblclick();
  const editor = page.getByRole("dialog", { name: "server.properties", exact: true });
  await editor.waitFor();
  await editor.getByText("5 lines", { exact: true }).waitFor();
  await editor.locator(".cm-editor").waitFor();
  await capture(page, "file-editor.png");
  await page.getByRole("button", { name: "Close editor" }).click();

  await openPage(page, "mods", "Mods");
  await page.getByRole("heading", { name: "Installed mods", exact: true }).waitFor();
  await capture(page, "mods.png");

  await openPage(page, "schedules", "Schedules");
  await page.getByRole("table", { name: "Schedules" }).waitFor();
  await capture(page, "schedules.png");

  await openPage(page, "properties", "Properties");
  await page.getByRole("heading", { name: "General", exact: true }).waitFor();
  await capture(page, "properties.png");

  await openPage(page, "settings", "Settings");
  await capture(page, "settings.png");

  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page.locator(".appShell.themeDark").waitFor();
  await openPage(page, "overview", "Overview");
  await waitForOverviewTimeline(page);
  await capture(page, "overview-dark.png");

  console.log(`Updated README screenshots in ${outputDirectory}`);
} finally {
  if (browser) await browser.close();
  if (harness) await harness.stop();
}
