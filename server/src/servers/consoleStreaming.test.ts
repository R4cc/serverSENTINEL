/**
 * Runs the real file-tail producer through the hub, so the path a viewer actually depends on —
 * workload output, framed into numbered lines, delivered to a subscriber and resumable from a
 * cursor — is covered end to end rather than only at its two ends.
 */

import { mkdtemp, mkdir, rm, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManagedServer } from "../types.js";
import { ConsoleHub } from "./consoleHub.js";
import { localStreamConsole } from "./localRuntimeAdapter.js";

let serverDir = "";
let server: ManagedServer;

/** The file tail polls once a second, so waits are expressed as "until", never as a fixed sleep. */
async function until(condition: () => boolean, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for console output.");
}

function collector() {
  const received: Array<{ seq: number; text: string }> = [];
  return {
    received,
    subscriber: {
      lines: (lines: Array<{ seq: number; text: string }>) => { received.push(...lines); },
      unavailable: () => {},
      empty: () => {}
    }
  };
}

beforeEach(async () => {
  serverDir = await mkdtemp(join(tmpdir(), "sentinel-console-stream-"));
  await mkdir(join(serverDir, "logs"), { recursive: true });
  await writeFile(join(serverDir, "logs", "latest.log"), "");
  // No docker container and no mount source, so the console falls back to tailing the file.
  server = { id: "server-under-test", serverDir } as ManagedServer;
});

afterEach(async () => {
  await rm(serverDir, { recursive: true, force: true });
});

describe("console streaming", () => {
  it("numbers lines a running workload appends and delivers them to viewers", async () => {
    const hub = new ConsoleHub(localStreamConsole);
    const viewer = collector();
    const session = await hub.attach(server, viewer.subscriber);
    session.start();

    await appendFile(join(serverDir, "logs", "latest.log"), "[12:00:00] [Server thread/INFO]: Done (5.1s)!\n");
    await until(() => viewer.received.length > 0);

    expect(viewer.received[0]).toEqual({
      seq: 1,
      text: "[12:00:00] [Server thread/INFO]: Done (5.1s)!\n"
    });
    hub.disposeAll();
  });

  it("gives a reconnecting viewer only what it missed", async () => {
    const hub = new ConsoleHub(localStreamConsole);
    const viewer = collector();
    const first = await hub.attach(server, viewer.subscriber);
    first.start();

    await appendFile(join(serverDir, "logs", "latest.log"), "before the reconnect\n");
    await until(() => viewer.received.length === 1);
    const cursor = { epoch: first.backlog.epoch, since: viewer.received[viewer.received.length - 1].seq };
    first.detach();

    await appendFile(join(serverDir, "logs", "latest.log"), "while disconnected\n");

    // The tail keeps running through the grace window, so the line is buffered whether it lands
    // before the viewer returns (arriving in its backlog) or after (arriving live).
    const returning = collector();
    const resumed = await hub.attach(server, returning.subscriber, cursor);
    resumed.start();
    const deliveredSoFar = () => [...resumed.backlog.lines, ...returning.received];
    await until(() => deliveredSoFar().some((line) => line.text === "while disconnected\n"));

    const delivered = deliveredSoFar().map((line) => line.text);
    expect(delivered).toContain("while disconnected\n");
    expect(delivered).not.toContain("before the reconnect\n");
    expect(resumed.backlog.epoch).toBe(first.backlog.epoch);
    hub.disposeAll();
  });

  it("keeps one tail for two viewers and numbers their lines identically", async () => {
    const hub = new ConsoleHub(localStreamConsole);
    const watching = collector();
    const alsoWatching = collector();
    const first = await hub.attach(server, watching.subscriber);
    first.start();
    const second = await hub.attach(server, alsoWatching.subscriber);
    second.start();

    await appendFile(join(serverDir, "logs", "latest.log"), "seen by both\n");
    await until(() => watching.received.length > 0 && alsoWatching.received.length > 0);

    expect(watching.received).toEqual(alsoWatching.received);
    hub.disposeAll();
  });

  it("frames a line that the workload writes in two parts", async () => {
    const hub = new ConsoleHub(localStreamConsole);
    const viewer = collector();
    const session = await hub.attach(server, viewer.subscriber);
    session.start();

    const logPath = join(serverDir, "logs", "latest.log");
    await appendFile(logPath, "a line split across");
    // Long enough for a poll to read the half-written line, which is the case being covered:
    // the partial has to be held rather than delivered as a line of its own.
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    expect(viewer.received).toEqual([]);
    await appendFile(logPath, " two writes\n");
    await until(() => viewer.received.length > 0);

    expect(viewer.received.map((line) => line.text)).toEqual(["a line split across two writes\n"]);
    hub.disposeAll();
  });
});
