/**
 * Checks the property the sequenced console exists to guarantee: a viewer that reconnects is sent
 * only the lines it missed, and the terminal appends them instead of clearing and redrawing.
 *
 * The console buffer is exercised directly over its HTTP and websocket surfaces rather than through
 * the browser, because what is being asserted is the panel's side of the contract: what a resume
 * returns for a given cursor.
 */

import { WebSocket } from "ws";
import { signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

const failures = [];

function check(description, condition, detail = "") {
  if (condition) {
    console.log(`  ok  ${description}`);
    return;
  }
  failures.push(`${description}${detail ? ` — ${detail}` : ""}`);
  console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ""}`);
}

/** Collects frames until `predicate` is satisfied, so a test never races the stream. */
function collectFrames(socket, predicate, timeoutMs = 10_000) {
  const frames = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for console frames. Got: ${JSON.stringify(frames)}`)), timeoutMs);
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      if (!predicate(frame, frames)) return;
      clearTimeout(timer);
      resolve(frames);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function openConsole(harness, cookie, serverId, cursor) {
  const resume = cursor ? `&epoch=${encodeURIComponent(cursor.epoch)}&since=${cursor.since}` : "";
  const socket = new WebSocket(
    `${harness.baseUrl.replace("http:", "ws:")}/ws/console?serverId=${encodeURIComponent(serverId)}${resume}`,
    { headers: { cookie } }
  );
  return socket;
}

const harness = await startDemoHarness({ dataDirectoryPrefix: "sentinel-console-resume-" });
try {
  // Demo mode blocks the real server APIs, so this runs against the panel with demo disabled and
  // drives a plain managed server whose console falls back to the file tail.
  const login = await fetch(`${harness.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ username: "demo", password: "demo" })
  });
  if (!login.ok) throw new Error(`Demo startup is broken: demo / demo could not sign in (${login.status}).`);
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

  const appResponse = await fetch(`${harness.baseUrl}/api/app`, { headers: { cookie, "X-Requested-With": "XMLHttpRequest" } });
  const app = await appResponse.json();
  const serverId = app.servers?.[0]?.id;
  if (!serverId) {
    console.log("No managed server is present in this demo panel, so there is no console to resume.");
    console.log("SKIPPED");
    process.exit(0);
  }

  console.log(`Console resume against server ${serverId}`);

  const first = openConsole(harness, cookie, serverId);
  const firstFrames = await collectFrames(first, (frame) => frame.type === "backlog");
  const backlog = firstFrames.find((frame) => frame.type === "backlog");
  check("the stream opens with a backlog frame", Boolean(backlog));
  check("the backlog carries an epoch", Boolean(backlog?.epoch), JSON.stringify(backlog?.epoch));
  check("the backlog reports the next sequence", Number.isInteger(backlog?.nextSeq));
  check(
    "backlog lines are numbered consecutively",
    backlog.lines.every((line, index) => index === 0 || line.seq === backlog.lines[index - 1].seq + 1),
    backlog.lines.slice(0, 5).map((line) => line.seq).join(",")
  );
  check("a first connection is not reported as truncated", backlog.truncated === false);

  const cursor = { epoch: backlog.epoch, since: backlog.nextSeq - 1 };
  first.close();

  // Reconnecting with a current cursor is the case that used to redraw the whole console.
  const second = openConsole(harness, cookie, serverId, cursor);
  const secondFrames = await collectFrames(second, (frame) => frame.type === "backlog");
  const resumed = secondFrames.find((frame) => frame.type === "backlog");
  check("resuming keeps the same epoch", resumed.epoch === backlog.epoch, `${backlog.epoch} -> ${resumed.epoch}`);
  check("resuming replays nothing already held", resumed.lines.length === 0, `${resumed.lines.length} lines replayed`);
  check("resuming is not reported as truncated", resumed.truncated === false);
  second.close();

  // A cursor from a buffer that no longer exists must be refused rather than trusted.
  const stale = openConsole(harness, cookie, serverId, { epoch: "a-buffer-that-never-existed", since: 5 });
  const staleFrames = await collectFrames(stale, (frame) => frame.type === "backlog");
  const rebuilt = staleFrames.find((frame) => frame.type === "backlog");
  check("an unknown epoch is answered with the current one", rebuilt.epoch === backlog.epoch);
  check(
    "an unknown epoch replays the retained buffer rather than resuming",
    rebuilt.lines.length === backlog.lines.length,
    `${rebuilt.lines.length} vs ${backlog.lines.length}`
  );
  stale.close();

  // The polling fallback has to answer the same cursor with the same numbering.
  const polled = await fetch(
    `${harness.baseUrl}/api/servers/${serverId}/console?epoch=${encodeURIComponent(cursor.epoch)}&since=${cursor.since}`,
    { headers: { cookie, "X-Requested-With": "XMLHttpRequest" } }
  );
  const pollBacklog = await polled.json();
  check("polling reads the same buffer as the stream", pollBacklog.epoch === backlog.epoch);
  check("polling resumes from the same cursor", pollBacklog.lines.length === 0, `${pollBacklog.lines.length} lines replayed`);

  if (failures.length) {
    console.log(`\n${failures.length} console resume check(s) failed:`);
    failures.forEach((failure) => console.log(`  - ${failure}`));
    process.exit(1);
  }
  console.log("\nAll console resume checks passed.");
} finally {
  await harness.stop();
}
