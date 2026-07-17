import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repositoryRoot, "docs", "screenshots");
const dataDirectory = await mkdtemp(join(tmpdir(), "serversentinel-readme-screenshots-"));
const port = Number(process.env.SERVERSENTINEL_SCREENSHOT_PORT || 4173);
const baseUrl = `http://127.0.0.1:${port}`;
const fixedTime = new Date("2026-01-15T12:00:00.000Z");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const [sansFontData, monoFontData] = await Promise.all([
  readFile(join(repositoryRoot, "node_modules", "@fontsource-variable", "inter", "files", "inter-latin-wght-normal.woff2"), "base64"),
  readFile(join(repositoryRoot, "node_modules", "@fontsource-variable", "cascadia-code", "files", "cascadia-code-latin-wght-normal.woff2"), "base64")
]);

let server;
let browser;
let serverOutput = "";

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

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Demo server stopped before it became ready.\n${serverOutput}`);
    }
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
        font-weight: 100 900;
        font-display: block;
        src: url("data:font/woff2;base64,${sansFontData}") format("woff2-variations");
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
    const [sans, mono] = await Promise.all([
      document.fonts.load('450 14px "serverSENTINEL Screenshot Sans"', "serverSENTINEL"),
      document.fonts.load('400 14px "serverSENTINEL Screenshot Mono"', "serverSENTINEL")
    ]);
    return { sans: sans.length, mono: mono.length };
  });
  if (!loadedFontCounts.sans || !loadedFontCounts.mono) {
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
  await timeline.locator(".serverTimelineEChart svg").waitFor();
}

try {
  if (process.env.SERVERSENTINEL_SCREENSHOT_SKIP_BUILD !== "true") {
    await runNpm(["run", "build"]);
  }

  await mkdir(outputDirectory, { recursive: true });

  server = spawn(process.execPath, [join(repositoryRoot, "server", "dist", "index.js")], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      LOG_LEVEL: "warn",
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
    stream.on("data", (chunk) => {
      serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
    });
  }
  await waitForServer();

  browser = await chromium.launch({
    headless: true,
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
  const loginResponse = await context.request.post(`${baseUrl}/api/auth/login`, {
    headers: { "X-Requested-With": "XMLHttpRequest" },
    data: { username: "demo", password: "demo" }
  });
  if (!loginResponse.ok()) {
    const detail = await loginResponse.text().catch(() => "");
    throw new Error(`Demo startup is broken: demo / demo could not sign in.${detail ? ` ${detail.trim()}` : ""}`);
  }
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

  try {
    await page.locator(".appShell").waitFor({ timeout: 15_000 });
  } catch {
    const notice = await page.locator(".notice").textContent().catch(() => "");
    throw new Error(`Demo startup is broken: demo / demo could not sign in.${notice ? ` ${notice.trim()}` : ""}`);
  }

  await page.locator(".workspaceHeader").getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await waitForOverviewTimeline(page);
  await capture(page, "overview.png");

  await openPage(page, "console", "Console");
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
