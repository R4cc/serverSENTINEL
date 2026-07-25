import { describe, expect, it } from "vitest";
import {
  ConsoleChatStream,
  consoleChatCommand,
  consoleChatEntries,
  consoleChatInitials,
  consoleChatTimeline,
  consoleChatTone,
  parseConsoleChatLine
} from "./consoleChat";

function line(text: string) {
  return `${text}\n`;
}

describe("console chat parsing", () => {
  it("reads vanilla chat lines with their author and time", () => {
    const entry = parseConsoleChatLine("[12:34:56] [Server thread/INFO]: <Notch> hello everyone", "a");

    expect(entry).toMatchObject({ kind: "chat", player: "Notch", text: "hello everyone", time: "12:34", dayMinutes: 754 });
  });

  it("ignores the chat signing prefix and section formatting", () => {
    const entry = parseConsoleChatLine("[12:00:00] [Server thread/INFO]: [Not Secure] <Steve> §chi §rthere", "a");

    expect(entry).toMatchObject({ kind: "chat", player: "Steve", text: "hi there" });
  });

  it("keeps a logger segment from being mistaken for the message", () => {
    const entry = parseConsoleChatLine("[12:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: <Alex> ping", "a");

    expect(entry).toMatchObject({ kind: "chat", player: "Alex", text: "ping" });
  });

  it("routes server broadcasts to the operator side", () => {
    const entry = parseConsoleChatLine("[12:00:00] [Server thread/INFO]: [Server] restarting in 5 minutes", "a");

    expect(entry).toMatchObject({ kind: "server", player: "", text: "restarting in 5 minutes", outgoing: true });
  });

  it("recognizes emotes, joins, leaves, advancements, and commands", () => {
    expect(parseConsoleChatLine("[12:00:00] [Server thread/INFO]: * Notch waves", "a")).toMatchObject({ kind: "emote", player: "Notch", text: "waves" });
    expect(parseConsoleChatLine("[12:00:00] [Server thread/INFO]: Notch joined the game", "a")).toMatchObject({ kind: "system", player: "Notch", text: "Notch joined the game" });
    expect(parseConsoleChatLine("[12:00:00] [Server thread/INFO]: Notch left the game", "a")).toMatchObject({ kind: "system", text: "Notch left the game" });
    expect(parseConsoleChatLine("[12:00:00] [Server thread/INFO]: Notch has made the advancement [Stone Age]", "a")).toMatchObject({
      kind: "system",
      text: "Notch made the advancement [Stone Age]"
    });
    expect(parseConsoleChatLine("[12:00:00] [Server thread/INFO]: Notch issued server command: /gamemode creative", "a")).toMatchObject({
      kind: "system",
      text: "Notch ran /gamemode creative"
    });
  });

  it("drops server noise that is not conversation", () => {
    expect(parseConsoleChatLine("[12:00:00] [Server thread/INFO]: Preparing spawn area: 42%", "a")).toBeNull();
    expect(parseConsoleChatLine("[12:00:00] [Server thread/WARN]: <Notch> suppressed", "a")).toBeNull();
    expect(parseConsoleChatLine("   ", "a")).toBeNull();
  });

  it("does not treat log payloads with angle brackets as chat", () => {
    expect(parseConsoleChatLine("[12:00:00] [Server thread/INFO]: <a very long sentence that is not a player name> nope", "a")).toBeNull();
  });
});

describe("console chat streaming", () => {
  it("buffers partial lines until their newline arrives", () => {
    const stream = new ConsoleChatStream();

    expect(stream.write("[12:00:00] [Server thread/INFO]: <Notch> par")).toEqual([]);
    expect(stream.write("tial\n")).toMatchObject([{ player: "Notch", text: "partial" }]);
  });

  it("assigns stable identifiers across chunks", () => {
    const entries = consoleChatEntries([
      line("[12:00:00] [Server thread/INFO]: <Notch> one"),
      line("[12:00:00] [Server thread/INFO]: <Notch> two")
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["chat-0", "chat-1"]);
  });

  it("keeps only the most recent messages", () => {
    const chunks = Array.from({ length: 12 }, (_, index) => line(`[12:00:00] [Server thread/INFO]: <Notch> message ${index}`));

    expect(consoleChatEntries(chunks, 3).map((entry) => entry.text)).toEqual(["message 9", "message 10", "message 11"]);
  });
});

describe("console chat timeline", () => {
  it("stacks consecutive messages from one author and splits on long pauses", () => {
    const entries = consoleChatEntries([
      line("[12:00:00] [Server thread/INFO]: <Notch> one"),
      line("[12:01:00] [Server thread/INFO]: <Notch> two"),
      line("[12:02:00] [Server thread/INFO]: <Steve> hello"),
      line("[12:40:00] [Server thread/INFO]: <Steve> later")
    ]);

    expect(consoleChatTimeline(entries).map((item) => item.type)).toEqual(["separator", "cluster", "cluster", "separator", "cluster"]);
    expect(consoleChatTimeline(entries).filter((item) => item.type === "cluster").map((item) => item.entries.length)).toEqual([2, 1, 1]);
  });

  it("never merges system notices into a message stack", () => {
    const entries = consoleChatEntries([
      line("[12:00:00] [Server thread/INFO]: <Notch> one"),
      line("[12:00:00] [Server thread/INFO]: Notch left the game"),
      line("[12:00:00] [Server thread/INFO]: <Notch> two")
    ]);

    expect(consoleChatTimeline(entries).map((item) => item.type)).toEqual(["separator", "cluster", "system", "cluster"]);
  });

  it("measures gaps across midnight instead of reading them as a full day backwards", () => {
    const shortWrap = consoleChatEntries([
      line("[23:58:00] [Server thread/INFO]: <Notch> late"),
      line("[00:05:00] [Server thread/INFO]: <Notch> early")
    ]);
    const longWrap = consoleChatEntries([
      line("[23:58:00] [Server thread/INFO]: <Notch> late"),
      line("[00:20:00] [Server thread/INFO]: <Notch> early")
    ]);

    expect(consoleChatTimeline(shortWrap).map((item) => item.type)).toEqual(["separator", "cluster", "cluster"]);
    expect(consoleChatTimeline(longWrap).map((item) => item.type)).toEqual(["separator", "cluster", "separator", "cluster"]);
  });
});

describe("console chat presentation", () => {
  it("gives each player a stable colour bucket regardless of casing", () => {
    expect(consoleChatTone("Notch")).toBe(consoleChatTone("notch"));
    expect(consoleChatTone("Notch")).toBeLessThan(8);
  });

  it("builds readable avatar placeholders", () => {
    expect(consoleChatInitials("Notch")).toBe("NO");
    expect(consoleChatInitials("dream_XD")).toBe("XD");
    expect(consoleChatInitials("___")).toBe("?");
  });

  it("broadcasts plain text and forwards explicit commands", () => {
    expect(consoleChatCommand("hello there")).toBe("say hello there");
    expect(consoleChatCommand("/list")).toBe("list");
    expect(consoleChatCommand("   ")).toBe("");
  });
});
