/**
 * Guards the console behaviours that have regressed repeatedly and that unit tests cannot see,
 * because they are properties of what xterm actually draws and of where the caret actually sits.
 *
 * Each assertion here stands for a specific defect that shipped at least once:
 *
 * - The terminal drew its own prompt line and rewrote it on every keystroke and every batch of
 *   arriving output. A frame painted mid-rewrite showed the line erased with the caret at column 0,
 *   which reads as flicker and a cursor jumping left.
 * - Erasing only the cursor's row left one stale copy of the command per keystroke once the input
 *   wrapped, which a phone-width terminal does for any ordinary command.
 * - The console reconciled a snapshot against the live stream by comparing text, and cleared and
 *   redrew every row whenever that comparison failed.
 * - Leaving the console page and returning rebuilt the terminal from scratch.
 * - The command field accepted input while its native caret was explicitly made transparent.
 * - Copying selected command text abandoned the entire line instead of leaving it available.
 * - Ctrl+C could not copy the output at all: xterm draws its own selection, so nothing the browser
 *   can see is selected and its native copy has nothing to act on.
 * - The compact tablet shell added its header above a 100vh console and hid the command line.
 * - xterm exposed its disabled input helper as an invisible keyboard and screen-reader target.
 * - The visible DOM renderer was replaced by WebGL one second later, changing the log drawing
 *   width and making wrapped output resize after the user had started reading it.
 */

import assert from "node:assert/strict";
import { chromium } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness, waitForAppShell } from "./lib/demo-harness.mjs";

const harness = await startDemoHarness({
  dataDirectoryPrefix: "serversentinel-console-smoke-",
  port: Number(process.env.SERVERSENTINEL_CONSOLE_SMOKE_PORT || 4189)
});
const { baseUrl } = harness;

let browser;
let rendererBrowser;

/** Rows xterm has actually drawn, blank ones dropped so trailing viewport padding is not compared. */
async function terminalRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".minecraftTerminal .xterm-rows > div")]
      .map((row) => row.textContent.replace(/[\s ]+$/, ""))
      .filter((row) => row.length > 0)
  );
}

async function commandCaret(page) {
  return page.locator(".consolePromptInput").evaluate((field) => ({
    value: field.value,
    start: field.selectionStart,
    end: field.selectionEnd,
    focused: document.activeElement === field
  }));
}

async function openConsole(page, { mobile = false } = {}) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForAppShell(page);
  const consoleLink = page.getByRole("button", { name: /console/i }).first();
  // The navigation starts collapsed on a phone.
  if (mobile && !await consoleLink.isVisible()) {
    await page.getByRole("button", { name: "Expand navigation" }).click();
  }
  await consoleLink.click();
  await page.locator(".minecraftTerminal .xterm-rows").first().waitFor();
  // xterm renders its row elements before anything is written into them, so waiting on the elements
  // alone lets the first assertion read a console that is merely still empty.
  await page.waitForFunction(() => [...document.querySelectorAll(".minecraftTerminal .xterm-rows > div")]
    .some((row) => row.textContent.trim().length > 0));
  await page.locator(".consolePromptInput").waitFor();
}

async function assertTerminalDrawsOutputOnly(page) {
  const rows = await terminalRows(page);
  assert(rows.length > 0, "The console drew no output at all");
  const promptRows = rows.filter((row) => row.trimStart().startsWith(">"));
  assert.deepEqual(
    promptRows,
    [],
    `The terminal is drawing a prompt line again, so command entry has moved back into it: ${JSON.stringify(promptRows)}`
  );
}

async function assertTerminalHelperIsNotInteractive(page) {
  const helper = await page.locator(".xterm-helper-textarea").evaluate((field) => ({
    ariaHidden: field.getAttribute("aria-hidden"),
    readOnly: field.readOnly,
    tabIndex: field.tabIndex
  }));
  assert.deepEqual(
    helper,
    { ariaHidden: "true", readOnly: true, tabIndex: -1 },
    `The output-only terminal exposed its invisible input helper: ${JSON.stringify(helper)}`
  );
}

async function assertTerminalHasOnlyOneFrame(page) {
  const nestedFrame = await page.locator(".minecraftTerminalViewport > .terminal.xterm").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderTopWidth: style.borderTopWidth,
      borderRightWidth: style.borderRightWidth,
      borderBottomWidth: style.borderBottomWidth,
      borderLeftWidth: style.borderLeftWidth,
      borderRadius: style.borderRadius
    };
  });
  assert.deepEqual(
    nestedFrame,
    {
      borderTopWidth: "0px",
      borderRightWidth: "0px",
      borderBottomWidth: "0px",
      borderLeftWidth: "0px",
      borderRadius: "0px"
    },
    `xterm inherited a second terminal frame: ${JSON.stringify(nestedFrame)}`
  );
}

/** Typing is the browser's business now: the output surface must not react to it at all. */
async function assertTypingLeavesOutputAlone(page) {
  const before = await terminalRows(page);
  const input = page.locator(".consolePromptInput");
  await input.click();
  const caretColor = await input.evaluate((field) => getComputedStyle(field).caretColor);
  assert(
    caretColor !== "transparent" && caretColor !== "rgba(0, 0, 0, 0)",
    `The focused command field has no visible caret: ${JSON.stringify(caretColor)}`
  );
  await input.type("say hello", { delay: 40 });

  assert.deepEqual(await terminalRows(page), before, "Typing a command changed what the terminal had drawn");
  const caret = await commandCaret(page);
  assert.equal(caret.value, "say hello", `The command line lost keystrokes: ${JSON.stringify(caret.value)}`);
  assert.equal(caret.start, caret.value.length, `The caret left the end of the typed text: ${JSON.stringify(caret)}`);

  // Long enough to wrap any terminal width this runs at, which is what used to duplicate rows.
  await input.fill("");
  await input.type(`say ${"abcdefghij".repeat(20)}`, { delay: 1 });
  assert.deepEqual(
    await terminalRows(page),
    before,
    "A command longer than the terminal width changed what the terminal had drawn"
  );
  await input.fill("");
}

/**
 * New output lands after what was already there, and the command that produced it is part of the
 * record. Rows are compared by order rather than by index because the viewport scrolls once the
 * console outgrows it, which a phone does immediately.
 *
 * This deliberately does not try to detect a clear-and-redraw: rewriting the buffer produces the
 * same rows, so the two are indistinguishable once the frame has settled. What makes a redraw
 * unnecessary — resuming by sequence rather than by comparing text — is asserted in
 * `server/src/servers/consoleChannel.test.ts`, where it can be observed directly.
 */
async function assertOutputIsAppendedInOrder(page) {
  const before = await terminalRows(page);
  const anchor = before[before.length - 1];
  const input = page.locator(".consolePromptInput");
  await input.click();
  await input.type("list");
  await page.keyboard.press("Enter");
  // Waits on the server's reply rather than on the echo, so a missing echo fails as an assertion
  // that names the problem instead of as an anonymous timeout.
  await page.waitForFunction(
    () => [...document.querySelectorAll(".minecraftTerminal .xterm-rows > div")]
      .map((row) => row.textContent.replace(/[\s ]+$/, ""))
      .join("")
      .includes("players online")
  );

  const after = await terminalRows(page);
  assert.equal(await input.inputValue(), "", "Submitting a command left it in the command line");

  const anchorIndex = after.lastIndexOf(anchor);
  assert(anchorIndex !== -1, `Output that was on screen before the command is gone: ${JSON.stringify(anchor)}`);
  const echoIndex = after.findIndex((row) => row.includes("> list"));
  assert(
    echoIndex > anchorIndex,
    `The submitted command was not echoed after the output that preceded it: ${JSON.stringify({ anchorIndex, echoIndex })}`
  );
}

async function assertJumpToBottomForUnseenOutput(page) {
  const jump = page.getByRole("button", { name: "Jump to bottom of console" });
  const input = page.locator(".consolePromptInput");
  assert.equal(await jump.count(), 0, "The jump-to-bottom action appeared before output was missed");

  // A tall desktop can hold the demo's whole initial transcript. Add ordinary command output until
  // there is enough history to move away from the live edge, without depending on xterm's private
  // virtual-scrollbar DOM (which is not a native scrollTop container in xterm 6).
  for (let index = 0; index < 24; index += 1) {
    const marker = `scrollback filler ${index}`;
    await input.fill(`say ${marker}`);
    await page.keyboard.press("Enter");
    await page.waitForFunction((text) => [...document.querySelectorAll(".minecraftTerminal .xterm-rows > div")]
      .some((row) => row.textContent.includes(text)), marker);
  }

  const liveRows = await terminalRows(page);
  await page.locator(".minecraftTerminal").hover();
  await page.mouse.wheel(0, -10_000);
  await page.waitForFunction((liveFirstRow) => {
    const firstRow = [...document.querySelectorAll(".minecraftTerminal .xterm-rows > div")]
      .map((row) => row.textContent.replace(/[\sÂ ]+$/, ""))
      .find((row) => row.length > 0);
    return firstRow && firstRow !== liveFirstRow;
  }, liveRows[0]);
  const rowsBeingRead = await terminalRows(page);
  assert.equal(await jump.count(), 0, "Merely scrolling up exposed the jump-to-bottom action");

  await input.fill("list");
  await page.keyboard.press("Enter");
  await jump.waitFor({ state: "visible" });
  assert.deepEqual(
    await terminalRows(page),
    rowsBeingRead,
    "New output moved the reader away from the lines they were reading"
  );

  await jump.click();
  await jump.waitFor({ state: "detached" });
  await page.waitForFunction(() => {
    return [...document.querySelectorAll(".minecraftTerminal .xterm-rows > div")]
      .map((row) => row.textContent.replace(/[\sÂ ]+$/, ""))
      .join("")
      .includes("players online");
  });
}

/** Arrow recall and Ctrl+C replace what a drawn prompt used to provide. */
async function assertCommandLineShortcuts(page) {
  const input = page.locator(".consolePromptInput");
  await input.click();
  await page.keyboard.press("ArrowUp");
  assert.equal(await input.inputValue(), "list", "Arrow up did not recall the previous command");
  await page.keyboard.press("ArrowDown");
  assert.equal(await input.inputValue(), "", "Arrow down did not return to the empty draft");

  // Typing itself is exercised above. Establish this shortcut fixture atomically so a pending
  // controlled-input commit cannot collapse the selection between selectText() and Ctrl+C.
  await input.fill("say copy me");
  await input.click();
  await input.selectText();
  await page.keyboard.press("Control+c");
  assert.equal(await input.inputValue(), "say copy me", "Ctrl+C abandoned selected command text instead of copying it");

  await input.fill("");
  await input.type("say oops");
  await page.keyboard.press("Control+c");
  assert.equal(await input.inputValue(), "", "Ctrl+C did not abandon the line");
}

/**
 * Selecting output and pressing Ctrl+C copies it. The selection belongs to xterm rather than to the
 * document, so the browser's own copy sees nothing to act on and the keystroke used to fall through
 * to the command line, which read it as the shell key that abandons the line.
 */
async function assertTerminalSelectionCopiesOnCtrlC(page) {
  const input = page.locator(".consolePromptInput");
  await input.click();
  await input.fill("say still here");

  const row = page.locator(".minecraftTerminal .xterm-rows > div").filter({ hasText: /\S/ }).first();
  const box = await row.boundingBox();
  // Dragged rather than clicked, and kept inside one row: a triple click would take the whole
  // logical line, which at this width may be wrapped across two of them.
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(160, box.width - 2), box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const rowText = (await row.textContent()).replace(/ /g, " ");
  await page.keyboard.press("Control+c");

  // Clipboard writes are asynchronous; Linux CI can still return the previous copy here.
  // Wait for selected output, not merely a nonempty clipboard left by the shortcut test.
  // Poll from Node: waitForFunction treats an async predicate's Promise as truthy.
  let copied = "";
  const deadline = Date.now() + 5_000;
  do {
    copied = await page.evaluate(() => navigator.clipboard.readText());
    if (copied.trim().length > 0 && rowText.includes(copied)) break;
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  assert(copied.trim().length > 0, "Ctrl+C copied nothing after selecting console output");
  assert(
    rowText.includes(copied),
    `Ctrl+C copied something other than the selected output: ${JSON.stringify({ copied, rowText })}`
  );
  assert.equal(
    await input.inputValue(),
    "say still here",
    "Ctrl+C abandoned the command line instead of copying the console selection"
  );
  await input.fill("");
}

async function assertCompactLandscapeKeepsCommandLineVisible(page) {
  const layout = await page.evaluate(() => {
    const prompt = document.querySelector(".consolePrompt")?.getBoundingClientRect();
    const terminal = document.querySelector(".minecraftTerminal")?.getBoundingClientRect();
    return {
      documentHeight: document.documentElement.scrollHeight,
      promptBottom: prompt?.bottom ?? 0,
      terminalHeight: terminal?.height ?? 0,
      viewportHeight: window.innerHeight
    };
  });
  assert(
    layout.promptBottom <= layout.viewportHeight,
    `The compact landscape console put its command line below the viewport: ${JSON.stringify(layout)}`
  );
  assert(
    layout.documentHeight <= layout.viewportHeight,
    `The compact landscape console made the document taller than the viewport: ${JSON.stringify(layout)}`
  );
  assert(layout.terminalHeight > 0, `The compact landscape console collapsed its output: ${JSON.stringify(layout)}`);
}

/**
 * Output arriving while a command is half-typed must not disturb the command line. A demo restart
 * replaces the console outright, which is the strongest version of this: even the case that clears
 * the terminal must leave the input alone.
 */
async function assertOutputDoesNotDisturbTheCommandLine(page) {
  const input = page.locator(".consolePromptInput");
  await input.click();
  await input.type("say half typed");
  await input.evaluate((field) => field.setSelectionRange(4, 4));
  const before = await commandCaret(page);

  await page.getByRole("button", { name: "Restart", exact: true }).click();
  // The demo server has players online, so restarting asks before disconnecting them.
  const confirmRestart = page.getByRole("button", { name: "Restart server", exact: true });
  await confirmRestart.waitFor();
  await page.getByLabel("Reason for restarting").fill("Console input preservation smoke test");
  await confirmRestart.click();
  await page.waitForFunction(
    () => [...document.querySelectorAll(".minecraftTerminal .xterm-rows > div")]
      .some((row) => row.textContent.includes("Restarting simulated server"))
  );
  assert(
    (await terminalRows(page)).some((row) => row.includes("Reason: Console input preservation smoke test")),
    "The restart reason was not preserved in the demo trace"
  );

  const after = await commandCaret(page);
  assert.equal(after.value, before.value, "Arriving console output changed what was typed in the command line");
  assert.equal(after.start, before.start, `Arriving console output moved the caret: ${JSON.stringify({ before, after })}`);
  // Focus is deliberately not asserted: producing output here means clicking a control, which takes
  // focus on its own, so a focus check would be measuring the click rather than the output.
  await input.fill("");
}

/** Browsing away and back must cost nothing: the same terminal, with the same rows still on it. */
async function assertConsoleSurvivesNavigation(page) {
  const before = await terminalRows(page);
  await page.evaluate(() => {
    window.__consoleCanvas = document.querySelector(".minecraftTerminal canvas, .minecraftTerminal .xterm-rows");
  });

  await page.getByRole("button", { name: /^files$/i }).first().click();
  await page.locator(".consoleTabPage").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /console/i }).first().click();
  await page.locator(".consoleTabPage").waitFor({ state: "visible" });

  const rebuilt = await page.evaluate(() =>
    window.__consoleCanvas !== document.querySelector(".minecraftTerminal canvas, .minecraftTerminal .xterm-rows")
  );
  assert(!rebuilt, "Returning to the console rebuilt the terminal instead of keeping the one that was already there");
  assert.deepEqual(
    await terminalRows(page),
    before,
    "Returning to the console redrew its contents instead of leaving them alone"
  );
}

async function createConsolePage(context, viewport) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(String(error)));
  return { page, browserErrors };
}

/** The renderer chosen for the first visible frame must remain the renderer after startup settles. */
async function assertRendererIsStableAfterReveal(context) {
  const { page, browserErrors } = await createConsolePage(context, { width: 1440, height: 900 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForAppShell(page);
  await page.getByRole("button", { name: /console/i }).first().click();
  await page.locator(".minecraftTerminal .xterm").waitFor({ state: "visible" });
  await page.locator(".consolePromptInput").waitFor();
  // Let the renderer commit the dimensions selected during initialization before sampling it.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const initial = await page.evaluate(() => {
    const screen = document.querySelector(".minecraftTerminal .xterm-screen");
    const surface = screen?.querySelector("canvas") ?? screen?.querySelector(".xterm-rows");
    window.__consoleRendererSurface = surface;
    const bounds = screen?.getBoundingClientRect();
    return {
      height: bounds?.height ?? 0,
      surface: surface?.tagName ?? "",
      width: bounds?.width ?? 0
    };
  });

  await page.waitForTimeout(1_250);
  const settled = await page.evaluate(() => {
    const screen = document.querySelector(".minecraftTerminal .xterm-screen");
    const surface = screen?.querySelector("canvas") ?? screen?.querySelector(".xterm-rows");
    const bounds = screen?.getBoundingClientRect();
    return {
      height: bounds?.height ?? 0,
      sameSurface: window.__consoleRendererSurface === surface,
      surface: surface?.tagName ?? "",
      width: bounds?.width ?? 0
    };
  });

  assert(
    settled.sameSurface && settled.surface === initial.surface,
    `The console replaced its visible renderer after opening: ${JSON.stringify({ initial, settled })}`
  );
  assert.deepEqual(
    { width: settled.width, height: settled.height },
    { width: initial.width, height: initial.height },
    `The console changed its drawing size after opening: ${JSON.stringify({ initial, settled })}`
  );
  assert.deepEqual(browserErrors, [], `Renderer stability browser errors: ${browserErrors.join("\n")}`);
  await page.close();
}

try {
  // The GPU renderer draws into a canvas, where the drawn text cannot be read back. Forcing the DOM
  // renderer exposes the rows xterm produced from its buffer, and every property asserted here —
  // what was drawn, and whether it was appended to or replaced — belongs to the buffer rather than
  // to the renderer. A defect specific to the WebGL path would not be caught here.
  browser = await launchBrowser(chromium, { args: ["--disable-webgl", "--disable-webgl2"] });
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    // Reading the clipboard back is the only way to assert that Ctrl+C copied what was selected.
    permissions: ["clipboard-read", "clipboard-write"]
  });
  // Exercise xterm's Linux selection mirror even when this smoke runs on Windows or macOS.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
  });
  await signInThroughApi(context, baseUrl);

  // Between the phone and desktop shells, navigation sits above the workspace. A short landscape
  // viewport must still leave the command line and output inside the visible area. Run this before
  // the desktop restart scenario so it observes the demo's initial console history.
  const compactLandscape = await createConsolePage(context, { width: 844, height: 390 });
  await openConsole(compactLandscape.page, { mobile: true });
  await assertTerminalHelperIsNotInteractive(compactLandscape.page);
  await assertTerminalHasOnlyOneFrame(compactLandscape.page);
  await assertCompactLandscapeKeepsCommandLineVisible(compactLandscape.page);
  assert.deepEqual(compactLandscape.browserErrors, [], `Compact landscape browser errors: ${compactLandscape.browserErrors.join("\n")}`);
  await compactLandscape.page.close();

  const desktop = await createConsolePage(context, { width: 1440, height: 900 });
  await openConsole(desktop.page);
  await assertTerminalDrawsOutputOnly(desktop.page);
  await assertTerminalHelperIsNotInteractive(desktop.page);
  await assertTerminalHasOnlyOneFrame(desktop.page);
  await assertTypingLeavesOutputAlone(desktop.page);
  await assertOutputIsAppendedInOrder(desktop.page);
  await assertJumpToBottomForUnseenOutput(desktop.page);
  await assertCommandLineShortcuts(desktop.page);
  await assertTerminalSelectionCopiesOnCtrlC(desktop.page);
  await assertOutputDoesNotDisturbTheCommandLine(desktop.page);
  await assertConsoleSurvivesNavigation(desktop.page);
  assert.deepEqual(desktop.browserErrors, [], `Desktop browser errors: ${desktop.browserErrors.join("\n")}`);
  await desktop.page.close();

  // A phone wraps any ordinary command, which is where the duplicated rows showed up first.
  const mobile = await createConsolePage(context, { width: 390, height: 844 });
  await openConsole(mobile.page, { mobile: true });
  await assertTerminalDrawsOutputOnly(mobile.page);
  await assertTerminalHelperIsNotInteractive(mobile.page);
  await assertTypingLeavesOutputAlone(mobile.page);
  await assertOutputIsAppendedInOrder(mobile.page);
  await assertJumpToBottomForUnseenOutput(mobile.page);
  assert.deepEqual(mobile.browserErrors, [], `Mobile browser errors: ${mobile.browserErrors.join("\n")}`);
  await mobile.page.close();

  // Exercise the ordinary renderer path separately: the main behavioural suite disables WebGL so
  // its text rows remain inspectable, but the delayed renderer swap only exists when WebGL works.
  rendererBrowser = await launchBrowser(chromium);
  const rendererContext = await rendererBrowser.newContext({ locale: "en-US", timezoneId: "UTC" });
  await signInThroughApi(rendererContext, baseUrl);
  await assertRendererIsStableAfterReveal(rendererContext);

  console.log("Console smoke passed: stable renderer, output-only terminal, usable command line, unseen-output jump, compact landscape layout, ordered output, and navigation survival.");
} finally {
  if (browser) await browser.close();
  if (rendererBrowser) await rendererBrowser.close();
  await harness.stop();
}
