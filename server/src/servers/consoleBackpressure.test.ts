import { describe, expect, it } from "vitest";
import { createConsoleSender, type BackpressuredClient } from "./consoleBackpressure.js";

function recordingClient(bufferedAmount = 0) {
  const sent: Array<Record<string, unknown>> = [];
  const client: BackpressuredClient & { bufferedAmount: number } = {
    readyState: 1,
    bufferedAmount,
    send: (payload) => { sent.push(JSON.parse(payload) as Record<string, unknown>); }
  };
  return { client, sent };
}

describe("console backpressure", () => {
  it("forwards frames while the client keeps up", () => {
    const { client, sent } = recordingClient();
    const sender = createConsoleSender(client, 1024);

    expect(sender.send({ type: "log", text: "a" })).toBe(true);
    expect(sender.send({ type: "log", text: "b" })).toBe(true);
    expect(sent.map((frame) => frame.text)).toEqual(["a", "b"]);
    expect(sender.droppedFrames()).toBe(0);
  });

  it("drops frames once the client queue passes the ceiling", () => {
    const { client, sent } = recordingClient(4096);
    const sender = createConsoleSender(client, 1024);

    expect(sender.send({ type: "log", text: "dropped" })).toBe(false);
    expect(sender.send({ type: "log", text: "also dropped" })).toBe(false);
    expect(sent).toEqual([]);
    expect(sender.droppedFrames()).toBe(2);
  });

  it("tells the viewer what it missed once the queue drains", () => {
    const { client, sent } = recordingClient(4096);
    const sender = createConsoleSender(client, 1024);

    sender.send({ type: "log", text: "dropped" });
    client.bufferedAmount = 0;
    expect(sender.send({ type: "log", text: "resumed" })).toBe(true);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ type: "truncated", droppedFrames: 1 });
    expect(sent[1]).toMatchObject({ type: "log", text: "resumed" });
  });

  it("announces the gap only once per drop burst", () => {
    const { client, sent } = recordingClient(4096);
    const sender = createConsoleSender(client, 1024);

    sender.send({ type: "log", text: "dropped" });
    client.bufferedAmount = 0;
    sender.send({ type: "log", text: "first" });
    sender.send({ type: "log", text: "second" });

    expect(sent.filter((frame) => frame.type === "truncated")).toHaveLength(1);
  });

  it("never sends to a client that is not open", () => {
    const { client, sent } = recordingClient();
    client.readyState = 3;
    const sender = createConsoleSender(client, 1024);

    expect(sender.send({ type: "log", text: "a" })).toBe(false);
    expect(sent).toEqual([]);
  });

  it("treats a client without bufferedAmount as always ready", () => {
    const sent: string[] = [];
    const sender = createConsoleSender({ readyState: 1, send: (payload) => { sent.push(payload); } }, 1024);

    expect(sender.send({ type: "log", text: "a" })).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
