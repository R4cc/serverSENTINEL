import { describe, expect, it, vi } from "vitest";
import { ConsoleChannel, type ConsoleUpstream } from "./consoleChannel.js";
import { ConsoleHub } from "./consoleHub.js";
import type { ManagedServer } from "../types.js";

function collector() {
  const received: Array<{ seq: number; text: string }> = [];
  return {
    received,
    /**
     * What this viewer would send to resume: the highest sequence it holds, counting both the
     * backlog it was handed and everything delivered live since. Tracking only one of the two is
     * what leaves a viewer asking for lines it already has.
     */
    cursor: (backlog: { epoch: string; nextSeq: number }) => ({
      epoch: backlog.epoch,
      since: Math.max(backlog.nextSeq - 1, ...received.map((line) => line.seq))
    }),
    subscriber: {
      lines: (lines: Array<{ seq: number; text: string }>) => { received.push(...lines); },
      unavailable: () => {},
      empty: () => {}
    }
  };
}

describe("ConsoleChannel", () => {
  it("numbers lines in arrival order", () => {
    const channel = new ConsoleChannel();
    channel.upstream().write("first\nsecond\n");
    expect(channel.backlog().lines).toEqual([
      { seq: 1, text: "first\n" },
      { seq: 2, text: "second\n" }
    ]);
  });

  it("holds a partial line until the rest of it arrives", () => {
    const channel = new ConsoleChannel();
    const upstream = channel.upstream();
    upstream.write("start of a li");
    expect(channel.backlog().lines).toEqual([]);
    upstream.write("ne\n");
    expect(channel.backlog().lines).toEqual([{ seq: 1, text: "start of a line\n" }]);
  });

  it("normalizes carriage returns so a line is framed the same either way", () => {
    const channel = new ConsoleChannel();
    channel.upstream().write("windows\r\nunix\n");
    expect(channel.backlog().lines.map((line) => line.text)).toEqual(["windows\n", "unix\n"]);
  });

  it("gives a resuming viewer only what it missed", () => {
    const channel = new ConsoleChannel();
    channel.upstream().write("a\nb\nc\n");
    const backlog = channel.backlog({ since: 2, epoch: channel.epoch });
    expect(backlog.lines).toEqual([{ seq: 3, text: "c\n" }]);
    expect(backlog.truncated).toBe(false);
    expect(backlog.nextSeq).toBe(4);
  });

  it("reports nothing missed when the viewer is already current", () => {
    const channel = new ConsoleChannel();
    channel.upstream().write("a\nb\n");
    const backlog = channel.backlog({ since: 2, epoch: channel.epoch });
    expect(backlog.lines).toEqual([]);
    expect(backlog.nextSeq).toBe(3);
  });

  it("ignores a cursor from a buffer that no longer exists", () => {
    const channel = new ConsoleChannel();
    channel.upstream().write("a\nb\n");
    const backlog = channel.backlog({ since: 1, epoch: "an-older-epoch" });
    expect(backlog.lines).toHaveLength(2);
    expect(backlog.epoch).toBe(channel.epoch);
    // The viewer is redrawing from scratch, so nothing was skipped from its point of view.
    expect(backlog.truncated).toBe(false);
  });

  it("tells a viewer that fell outside the retained window that lines were skipped", () => {
    const channel = new ConsoleChannel({ maxLines: 3 });
    channel.upstream().write("a\nb\nc\nd\ne\n");
    const backlog = channel.backlog({ since: 1, epoch: channel.epoch });
    expect(backlog.lines.map((line) => line.seq)).toEqual([3, 4, 5]);
    expect(backlog.truncated).toBe(true);
  });

  it("keeps sequence numbers stable while trimming the head", () => {
    const channel = new ConsoleChannel({ maxLines: 2 });
    channel.upstream().write("a\nb\nc\n");
    expect(channel.backlog().lines).toEqual([
      { seq: 2, text: "b\n" },
      { seq: 3, text: "c\n" }
    ]);
  });

  it("trims to the byte ceiling as well as the line ceiling", () => {
    const channel = new ConsoleChannel({ maxBytes: 20 });
    channel.upstream().write(`${"x".repeat(15)}\n${"y".repeat(15)}\n`);
    const lines = channel.backlog().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].text.startsWith("y")).toBe(true);
  });

  it("delivers appended lines to every subscriber", () => {
    const channel = new ConsoleChannel();
    const first = collector();
    const second = collector();
    channel.subscribe(first.subscriber);
    channel.subscribe(second.subscriber);
    channel.upstream().write("shared\n");
    expect(first.received).toEqual([{ seq: 1, text: "shared\n" }]);
    expect(second.received).toEqual(first.received);
  });

  it("stops delivering to a viewer that detached", () => {
    const channel = new ConsoleChannel();
    const viewer = collector();
    const unsubscribe = channel.subscribe(viewer.subscriber);
    channel.upstream().write("seen\n");
    unsubscribe();
    channel.upstream().write("unseen\n");
    expect(viewer.received.map((line) => line.text)).toEqual(["seen\n"]);
  });

  it("numbers a panel notice alongside workload output so a gap is visible in order", () => {
    const channel = new ConsoleChannel();
    const upstream = channel.upstream();
    upstream.write("before\n");
    upstream.notice("[serverSENTINEL] Reconnected to the log stream.");
    upstream.write("after\n");
    expect(channel.backlog().lines.map((line) => line.text)).toEqual([
      "before\n",
      "[serverSENTINEL] Reconnected to the log stream.\n",
      "after\n"
    ]);
  });

  it("replays a remembered failure to a viewer that arrives after it", () => {
    const channel = new ConsoleChannel();
    channel.upstream().unavailable("Node is offline", { code: "NODE_OFFLINE", retryable: true });
    const unavailable = vi.fn();
    channel.subscribe({ lines: () => {}, unavailable, empty: () => {} });
    expect(unavailable).toHaveBeenCalledWith("Node is offline", expect.objectContaining({ code: "NODE_OFFLINE" }));
  });

  it("forgets a failure the producer has since written past", () => {
    const channel = new ConsoleChannel();
    const upstream = channel.upstream();
    upstream.unavailable("Docker logs returned 404", { retryable: true });
    upstream.write("the follow reattached and output resumed\n");
    const unavailable = vi.fn();
    channel.subscribe({ lines: () => {}, unavailable, empty: () => {} });
    expect(unavailable).not.toHaveBeenCalled();
  });
});

const testServer = { id: "server-1" } as ManagedServer;

describe("ConsoleHub", () => {
  it("follows the workload once no matter how many viewers attach", async () => {
    const start = vi.fn().mockResolvedValue(() => {});
    const hub = new ConsoleHub(start);
    await hub.attach(testServer, collector().subscriber);
    await hub.attach(testServer, collector().subscriber);
    expect(start).toHaveBeenCalledTimes(1);
    hub.disposeAll();
  });

  it("starts the producer only once when viewers attach together", async () => {
    let resolveStart: (stop: () => void) => void = () => {};
    const start = vi.fn(() => new Promise<() => void>((resolve) => { resolveStart = resolve; }));
    const hub = new ConsoleHub(start);
    const attaching = [hub.attach(testServer, collector().subscriber), hub.attach(testServer, collector().subscriber)];
    resolveStart(() => {});
    await Promise.all(attaching);
    expect(start).toHaveBeenCalledTimes(1);
    hub.disposeAll();
  });

  it("resumes a returning viewer from its cursor instead of replaying the buffer", async () => {
    const hub = new ConsoleHub(async (_server, upstream) => {
      upstream.write("one\ntwo\n");
      return () => {};
    });
    const viewer = collector();
    const first = await hub.attach(testServer, viewer.subscriber);
    first.start();
    // The lines arrived live rather than in the backlog, so the cursor comes from what was delivered.
    expect(viewer.received.map((line) => line.text)).toEqual(["one\n", "two\n"]);
    const second = await hub.attach(testServer, collector().subscriber, viewer.cursor(first.backlog));
    expect(second.backlog.lines).toEqual([]);
    expect(second.backlog.epoch).toBe(first.backlog.epoch);
    hub.disposeAll();
  });

  it("keeps the buffer while the last viewer is away and hands back only new lines", async () => {
    let sink: { write: (chunk: string) => void } | undefined;
    const hub = new ConsoleHub(async (_server, upstream) => {
      sink = upstream;
      return () => {};
    });
    const viewer = collector();
    const first = await hub.attach(testServer, viewer.subscriber);
    first.start();
    sink?.write("before\n");
    const cursor = viewer.cursor(first.backlog);
    first.detach();

    sink?.write("while away\n");
    const returning = await hub.attach(testServer, collector().subscriber, cursor);
    expect(returning.backlog.epoch).toBe(first.backlog.epoch);
    expect(returning.backlog.lines.map((line) => line.text)).toEqual(["while away\n"]);
    hub.disposeAll();
  });

  it("holds live output until the backlog has been sent, then delivers it in order", async () => {
    // The producer emits while it is being attached, which is exactly when a viewer has its
    // backlog but has not been sent it yet.
    const hub = new ConsoleHub(async (_server, upstream) => {
      upstream.write("arrived during attach\n");
      return () => {};
    });
    const viewer = collector();
    const session = await hub.attach(testServer, viewer.subscriber);
    expect(viewer.received).toEqual([]);
    session.start();
    expect(viewer.received.map((line) => line.text)).toEqual(["arrived during attach\n"]);
    hub.disposeAll();
  });

  it("releases the producer once the grace window passes with nobody watching", async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn();
      const hub = new ConsoleHub(async () => stop, 1_000);
      const session = await hub.attach(testServer, collector().subscriber);
      session.detach();
      expect(stop).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the producer when a viewer returns inside the grace window", async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn();
      const hub = new ConsoleHub(async () => stop, 1_000);
      const session = await hub.attach(testServer, collector().subscriber);
      session.detach();
      vi.advanceTimersByTime(500);
      await hub.attach(testServer, collector().subscriber);
      vi.advanceTimersByTime(1_000);
      expect(stop).not.toHaveBeenCalled();
      hub.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a new epoch after the buffer was evicted, so the viewer knows to redraw", async () => {
    vi.useFakeTimers();
    try {
      const hub = new ConsoleHub(async () => () => {}, 1_000);
      const first = await hub.attach(testServer, collector().subscriber);
      first.detach();
      vi.advanceTimersByTime(1_000);
      const second = await hub.attach(testServer, collector().subscriber, {
        since: 1,
        epoch: first.backlog.epoch
      });
      expect(second.backlog.epoch).not.toBe(first.backlog.epoch);
      hub.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a producer that fails to start as unavailable rather than hanging the viewer", async () => {
    const failure = Object.assign(new Error("Node is offline"), { code: "node_offline" });
    const hub = new ConsoleHub(async () => { throw failure; });
    const unavailable = vi.fn();
    const session = await hub.attach(testServer, { lines: () => {}, unavailable, empty: () => {} });
    session.start();
    expect(unavailable).toHaveBeenCalledWith("Node is offline", expect.objectContaining({
      code: "NODE_OFFLINE",
      retryable: true
    }));
    hub.disposeAll();
  });

  it("starts a new producer for the next viewer after the previous one ended", async () => {
    // A node hop ends when the node's stream ends. Holding it as live is what left a returning
    // viewer watching a console nothing was writing to.
    let end: () => void = () => {};
    const stop = vi.fn();
    const start = vi.fn(async (_server: ManagedServer, upstream: ConsoleUpstream) => {
      end = () => upstream.ended?.();
      return stop;
    });
    const hub = new ConsoleHub(start);
    const first = await hub.attach(testServer, collector().subscriber);
    first.detach();
    end();

    await hub.attach(testServer, collector().subscriber);
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
    hub.disposeAll();
  });

  it("does not replay the failure that ended a producer to the viewer that restarts it", async () => {
    // The node was offline, the stream ended, and the node came back. The next viewer's verdict
    // comes from the producer it starts, not from what the previous one reported on its way out.
    let attempt = 0;
    const hub = new ConsoleHub(async (_server: ManagedServer, upstream: ConsoleUpstream) => {
      attempt += 1;
      if (attempt === 1) {
        upstream.unavailable("Node disconnected", { code: "NODE_OFFLINE", retryable: true });
        upstream.ended?.();
        return () => {};
      }
      upstream.write("the node is back\n");
      return () => {};
    });
    const first = await hub.attach(testServer, collector().subscriber);
    first.start();
    first.detach();

    const viewer = collector();
    const unavailable = vi.fn();
    const returning = await hub.attach(testServer, { ...viewer.subscriber, unavailable });
    returning.start();

    expect(unavailable).not.toHaveBeenCalled();
    expect(viewer.received.map((line) => line.text)).toEqual(["the node is back\n"]);
    hub.disposeAll();
  });

  it("retries the producer on the next attach after a failed start", async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(new Error("Docker is not reachable"))
      .mockResolvedValueOnce(() => {});
    const hub = new ConsoleHub(start);
    await hub.attach(testServer, collector().subscriber);
    await hub.attach(testServer, collector().subscriber);
    expect(start).toHaveBeenCalledTimes(2);
    hub.disposeAll();
  });
});
