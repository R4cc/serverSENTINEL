import assert from "node:assert/strict";
import { chromium } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

// Synthetic transport, production UI: no real workload or private console data is used.
let harness;
const browser = await launchBrowser(chromium, { args: ["--disable-webgl", "--disable-webgl2"] });
const results = [];
const payload = (count, start = 1) => Array.from({ length: count }, (_, index) => {
  const seq = start + index;
  const detail = seq % 10 === 0 ? `§aGreen§r \u001b[33mANSI\u001b[0m ${"wrapped output ".repeat(30)}` : "ordinary server output";
  return { seq, text: `${detail} ROW_${seq}_END\n` };
});
try {
  // Each group gets its own server so repeated cold asset downloads stay below rate limits.
  for (const width of [1440, 390]) for (const count of [0, 100, 5000, 25000]) {
    harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-console-loading-" });
    const signedIn = await browser.newContext();
    await signInThroughApi(signedIn, harness.baseUrl);
    const storageState = await signedIn.storageState();
    const headers = { "X-Requested-With": "XMLHttpRequest" };
    const session = await (await signedIn.request.get(`${harness.baseUrl}/api/auth/session`, { headers })).json();
    const base = await (await signedIn.request.get(`${harness.baseUrl}/api/app`, { headers })).json();
    await signedIn.close();
    for (let repeat = 0; repeat < Number(process.env.CONSOLE_LOADING_REPEATS || 3); repeat++) {
      const context = await browser.newContext({ storageState, viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const server = {
        id: "console-loading", displayName: "Console loading", nodeId: "local", nodeName: "Panel Host",
        directoryLabel: "/test/console", storageName: "console", schedules: [],
        runtimeProfile: { minecraftVersion: "1.21.4", runtimeType: "fabric", javaMajorVersion: 21 },
        dockerContainer: "console", dockerImage: "test", hasDockerContainer: true,
        javaArgs: "-Xmx2G", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      const nodes = [{ id: "local", name: "Panel Host", type: "local", status: "online", isInternal: true, dockerStatus: "available", dataPathStatus: "ready" }];
      const beta = { ...server, id: "console-beta", displayName: "Beta" };
      const page = await context.newPage();
      const errors = [];
      const failedRequests = [];
      page.on("pageerror", error => errors.push(error.message));
      // Navigation deliberately aborts unrelated reads; retain them only as loading diagnostics.
      page.on("requestfailed", request => failedRequests.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
      await page.addInitScript(() => {
        localStorage.setItem("serversentinel-console-scrollback", "25000");
        window.consoleTiming = { started: 0, visible: 0, gaps: [] };
        let previous = 0;
        const frame = now => {
          const timing = window.consoleTiming;
          if (timing.started) {
            if (previous) timing.gaps.push(now - previous);
            if (!timing.visible && document.querySelector(".minecraftTerminal:not(.initializing)")) timing.visible = now;
          }
          previous = now;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      let lines = payload(count), epoch = "loading-epoch", socket, onConnect;
      const connections = [];
      await page.routeWebSocket("**/ws/console?*", ws => {
        socket = ws;
        const cursor = new URL(ws.url()).searchParams;
        if (cursor.get("serverId") === beta.id) {
          const delayed = setTimeout(() => ws.send(JSON.stringify({ type: "backlog", epoch: "beta", lines: [{ seq: 1, text: "BETA_ONLY\n" }], nextSeq: 2, truncated: false })), 300);
          ws.onClose(() => clearTimeout(delayed));
          onConnect?.();
          return;
        }
        connections.push(Number(cursor.get("since") || 0));
        const since = cursor.get("epoch") === epoch ? Number(cursor.get("since")) : 0;
        ws.send(JSON.stringify({ type: "backlog", epoch, lines: lines.filter(line => line.seq > since), nextSeq: (lines.at(-1)?.seq ?? 0) + 1, truncated: false }));
        onConnect?.();
      });
      await page.route("**/api/**", route => {
        const path = new URL(route.request().url()).pathname;
        const json = body => route.fulfill({ json: body });
        if (path === "/api/auth/session") return json({ ...session, demo: false });
        if (path === "/api/app") return json({ ...base, servers: [server, beta], nodes, currentUser: session.user, dockerSocketMounted: true });
        if (path === "/api/nodes") return json({ nodes });
        if (path.endsWith("/status")) return json({ server: path.includes(beta.id) ? beta : server, docker: { configured: true, available: true, controllable: true, running: true, state: "running" }, lifecycle: { state: "running", intent: "running" }, commandInputAvailable: true, fileLogsAvailable: true });
        if (path.endsWith("/events")) return json({ events: [], activity: {} });
        if (path.endsWith("/files")) return json({ path: "/", entries: [] });
        if (path.endsWith("/console")) return json({ epoch, lines, nextSeq: (lines.at(-1)?.seq ?? 0) + 1, truncated: false });
        return route.continue();
      });
      const navigate = async name => {
        let timeout;
        const connected = name === "console" ? new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Console did not reconnect")), 10000);
          onConnect = resolve;
        }) : Promise.resolve();
        try {
          await Promise.all([page.locator(`[data-nav-page="${name}"]`).evaluate(element => element.click()), connected]);
        } finally { clearTimeout(timeout); }
      };
      const waitForTail = async seq => {
        try {
          await page.waitForFunction(seq => [...document.querySelectorAll(".xterm-rows > div")].map(row => row.textContent).join("").includes(`ROW_${seq}_END`), seq);
        } catch (error) {
          const state = await page.evaluate(() => ({
            text: document.querySelector(".xterm-rows")?.textContent,
            newOutputAvailable: !!document.querySelector(".consoleJumpToBottom")
          }));
          throw new Error(`Console tail missing: ${JSON.stringify({ width, count, repeat, seq, connections, errors, state })}`, { cause: error });
        }
      };
      await page.goto(harness.baseUrl);
      await page.locator(".appShell").waitFor().catch(error => {
        throw new Error(`App shell failed to load: ${[...errors, ...failedRequests].join("; ")}`, { cause: error });
      });
      await page.evaluate(() => { window.consoleTiming.started = performance.now(); });
      await navigate("console");
      await page.waitForFunction(() => window.consoleTiming.visible > 0);
      if (count) await waitForTail(count);
      const initial = await page.evaluate(() => ({ visibleMs: window.consoleTiming.visible - window.consoleTiming.started, maxFrameGapMs: Math.max(0, ...window.consoleTiming.gaps) }));
      await page.locator(".consolePromptInput").fill("say unfinished draft");
      await page.evaluate(() => { window.retainedTerminal = document.querySelector(".xterm"); });
      await navigate("files");
      lines.push(...payload(100, count + 1));
      const revisitStart = await page.evaluate(() => performance.now());
      await navigate("console");
      await waitForTail(count + 100);
      const revisitMs = await page.evaluate(start => performance.now() - start, revisitStart);
      assert.equal(await page.evaluate(() => window.retainedTerminal === document.querySelector(".xterm")), true, "revisit rebuilt terminal");
      assert.equal(connections.at(-1), count, "revisit did not resume from received history");
      assert.equal(await page.locator(".consolePromptInput").inputValue(), "say unfinished draft", "catch-up disturbed command input");
      await navigate("files");
      await navigate("console");
      await waitForTail(count + 100);
      assert.equal(await page.evaluate(() => window.retainedTerminal === document.querySelector(".xterm")), true);

      if (!process.env.CONSOLE_LOADING_BASELINE) {
        // Hold the next frame flush; deliver output, then navigate before it can commit.
        // Keep distinct handles and honor cancellation, including after release. Replaying
        // canceled layout/render callbacks can falsely move xterm away from its latest line.
        await page.evaluate(() => {
          window.savedRAF = window.requestAnimationFrame;
          const cancel = window.cancelAnimationFrame.bind(window);
          window.heldFrames = new Map();
          let nextId = -1;
          window.requestAnimationFrame = callback => {
            const id = nextId--;
            window.heldFrames.set(id, { callback });
            return id;
          };
          window.cancelAnimationFrame = id => {
            const held = window.heldFrames.get(id);
            if (held) {
              window.heldFrames.delete(id);
              if (held.nativeId !== undefined) cancel(held.nativeId);
            } else cancel(id);
          };
        });
        const next = payload(1, count + 101);
        lines.push(...next);
        socket.send(JSON.stringify({ type: "log", epoch, lines: next }));
        await page.waitForFunction(() => window.heldFrames.size >= 2);
        await navigate("files");
        await page.locator(".consoleTabPage").waitFor({ state: "hidden" });
        await page.evaluate(() => {
          window.requestAnimationFrame = window.savedRAF;
          for (const [id, held] of window.heldFrames) {
            held.nativeId = requestAnimationFrame(time => {
              window.heldFrames.delete(id);
              held.callback(time);
            });
          }
        });
        await navigate("console");
        await waitForTail(count + 101);
        // Replayed overlapping lines must not appear twice, even when their text is identical.
        const overlap = payload(2, count + 101);
        lines.push(overlap[1]);
        socket.send(JSON.stringify({ type: "log", epoch, lines: overlap }));
        await waitForTail(count + 102);
        const visibleText = await page.locator(".xterm-rows").textContent();
        assert.equal(visibleText.split(`ROW_${count + 101}_END`).length - 1, 1, "overlap duplicated output");

        await page.locator(".minecraftTerminal").hover();
        await page.mouse.wheel(0, -1000);
        await page.waitForFunction(seq => !document.querySelector(".xterm-rows")?.textContent.includes(`ROW_${seq}_END`), count + 102);
        const reading = await page.locator(".xterm-rows").textContent();
        const unseen = payload(1, count + 103);
        lines.push(...unseen);
        socket.send(JSON.stringify({ type: "log", epoch, lines: unseen }));
        const jump = page.getByRole("button", { name: "Jump to bottom of console" });
        await jump.waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator(".xterm-rows").textContent(), reading, "arriving output moved the reader");
        await jump.click();
        await waitForTail(count + 103);
        // A new epoch replaces, rather than appends to, the old history.
        epoch = "replacement-epoch";
        lines = [{ seq: 1, text: "REPLACEMENT_ONLY\n" }];
        socket.send(JSON.stringify({ type: "backlog", epoch, lines, nextSeq: 2, truncated: false }));
        await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.includes("REPLACEMENT_ONLY"));
        assert(!await page.locator(".xterm-rows").textContent().then(text => text.includes("ROW_")), "old epoch remained visible");

        if (count === 25000 && repeat === 0) {
          if (!await page.getByRole("button", { name: /Switch server/ }).isVisible()) {
            await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
          }
          await page.getByRole("button", { name: /Switch server/ }).click();
          await page.getByRole("menuitem", { name: /Beta/ }).click();
          await navigate("console");
          await page.locator(".minecraftTerminal.initializing").waitFor();
          assert.equal(await page.evaluate(() => window.retainedTerminal === document.querySelector(".xterm")), false, "another server reused the previous terminal");
          assert(!await page.locator(".xterm-rows").textContent().then(text => text.includes("REPLACEMENT_ONLY")), "server switch exposed stale output");
          // Navigate while the replacement server's snapshot is still in flight.
          await navigate("files");
          await navigate("console");
          await page.waitForFunction(() => document.querySelector(".minecraftTerminal:not(.initializing) .xterm-rows")?.textContent.includes("BETA_ONLY"));
        }
      }
      assert.deepEqual(errors, []);
      results.push({ width, count, repeat, ...initial, revisitMs });
      console.log(JSON.stringify(results.at(-1)));
      await context.close();
    }
    await harness.stop();
    harness = null;
  }
  console.log("Console loading smoke passed.");
} finally {
  await browser.close();
  await harness?.stop();
}
