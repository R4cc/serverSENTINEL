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

  it("reads the rank-prefixed format chat plugins print", () => {
    expect(parseConsoleChatLine("[18:11:54] [Server thread/INFO]: [ADM] Alezhshede : gg", "a")).toMatchObject({
      kind: "chat",
      player: "Alezhshede",
      rank: "ADM",
      text: "gg",
      time: "18:11"
    });
    expect(parseConsoleChatLine("[18:46:47] [Server thread/INFO]: [NEW] Forest_Dweller : ???", "a")).toMatchObject({
      kind: "chat",
      player: "Forest_Dweller",
      rank: "NEW",
      text: "???"
    });
    expect(parseConsoleChatLine("[18:46:29] [Server thread/INFO]: [ADM] Alezhshede : I have all the resources for the thing with the thing", "a")).toMatchObject({
      kind: "chat",
      text: "I have all the resources for the thing with the thing"
    });
  });

  it("reads rank-prefixed and rank-less variants of the bracketed name format", () => {
    expect(parseConsoleChatLine("[12:00:00] [Server thread/INFO]: [VIP+] <Steve> hello", "a")).toMatchObject({
      kind: "chat",
      player: "Steve",
      rank: "VIP+",
      text: "hello"
    });
    expect(parseConsoleChatLine("[12:00:00] [Server thread/INFO]: Steve : hello", "a")).toMatchObject({
      kind: "chat",
      player: "Steve",
      rank: "",
      text: "hello"
    });
  });

  it("reads vanilla death notices without matching mob death log lines", () => {
    expect(parseConsoleChatLine("[18:12:40] [Server thread/INFO]: Not_French1e withered away", "a")).toMatchObject({
      kind: "system",
      player: "Not_French1e",
      text: "Not_French1e withered away"
    });
    expect(parseConsoleChatLine("[12:00:00] [Server thread/INFO]: Steve was slain by Zombie", "a")).toMatchObject({ kind: "system", text: "Steve was slain by Zombie" });
    expect(parseConsoleChatLine("[12:00:00] [Server thread/INFO]: Steve fell from a high place", "a")).toMatchObject({ kind: "system" });
    expect(parseConsoleChatLine("[12:00:00] [Server thread/INFO]: Steve tried to swim in lava", "a")).toMatchObject({ kind: "system" });
    expect(parseConsoleChatLine("[18:45:12] [Server thread/INFO]: Villager Villager['Villager'/508743, l='ServerLevel[world]', x=452.70, y=92.00, z=186.24] died, message: 'Villager was slain by Forest_Dweller'", "a")).toBeNull();
  });

  it("drops the plugin and subsystem noise that surrounds real chat", () => {
    const noise = [
      "[18:12:52] [VoiceChatPacketProcessingThread/INFO]: [voicechat] Player 1fbfec46-9023-413c-8ffb-c46e69208f58 timed out",
      "[18:12:52] [VoiceChatPacketProcessingThread/INFO]: [voicechat] Reconnecting player ItsKapi",
      "[18:12:54] [VoiceChatPacketProcessingThread/INFO]: [voicechat] Player ItsKapi (1fbfec46-9023-413c-8ffb-c46e69208f58) successfully connected to voice chat",
      "[18:15:24] [User Authenticator #38/INFO]: UUID of player dindingle is c2ef02b8-8779-4e96-8e04-2e74cfe4cc24",
      "[18:15:26] [Server thread/INFO]: dindingle[/24.214.66.26:62286] logged in with entity id 530137 at (774.06, 64.0, 933.45)",
      "[18:15:26] [Server thread/INFO]: [voicechat] Received secret request of dindingle (20)",
      "[18:19:33] [Server thread/WARN]: Mismatch in destroy block pos: BlockPos{x=474, y=66, z=222} BlockPos{x=472, y=67, z=225}",
      "[18:34:20] [Server thread/WARN]: Not_French1e moved too quickly! -0.019,-10.109,0.0",
      "[18:37:27] [Server thread/INFO]: Not_French1e lost connection: Disconnected",
      "[18:37:27] [Server thread/INFO]: [voicechat] Disconnecting client Not_French1e",
      "[18:46:15] [Server thread/WARN]: Couldn't smelt 1 minecraft:tropical_fish because there is no smelting recipe",
      "[18:53:02] [aempire-integrations/INFO]: Set Forest_Dweller to playtime status member."
    ];

    expect(noise.map((entry) => parseConsoleChatLine(entry, "a"))).toEqual(noise.map(() => null));
  });

  it("keeps a real transcript in order and drops everything around it", () => {
    const transcript = [
      "[18:11:51] [Server thread/INFO]: Not_French1e has made the advancement [Withering Heights]",
      "[18:11:54] [Server thread/INFO]: [ADM] Alezhshede : gg",
      "[18:12:40] [Server thread/INFO]: Not_French1e withered away",
      "[18:12:50] [Server thread/INFO]: [ADM] Alezhshede : you good?",
      "[18:12:52] [VoiceChatPacketProcessingThread/INFO]: [voicechat] Reconnecting player ItsKapi",
      "[18:12:55] [Server thread/INFO]: [MEM] Not_French1e : yer",
      "[18:15:26] [Server thread/INFO]: dindingle joined the game",
      "[18:37:27] [Server thread/INFO]: Not_French1e left the game"
    ].map((entry) => `${entry}\n`);

    expect(consoleChatEntries(transcript).map((entry) => `${entry.kind}:${entry.player}:${entry.text}`)).toEqual([
      "system:Not_French1e:Not_French1e made the advancement [Withering Heights]",
      "chat:Alezhshede:gg",
      "system:Not_French1e:Not_French1e withered away",
      "chat:Alezhshede:you good?",
      "chat:Not_French1e:yer",
      "system:dindingle:dindingle joined the game",
      "system:Not_French1e:Not_French1e left the game"
    ]);
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
