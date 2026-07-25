import { describe, expect, it } from "vitest";
import type { PlayerSnapshot } from "../types";
import { onlinePlayerCount, runtimeActionConfirmation } from "./runtimeConfirmation";

function liveSnapshot(names: string[]): PlayerSnapshot {
  return { state: "live", online: names.length, maxPlayers: 20, names, sampledAt: "2026-07-25T10:00:00.000Z" };
}

describe("onlinePlayerCount", () => {
  it("counts live and stale players and ignores stopped or unavailable snapshots", () => {
    expect(onlinePlayerCount(undefined)).toBe(0);
    expect(onlinePlayerCount(liveSnapshot(["Alex", "Steve"]))).toBe(2);
    expect(onlinePlayerCount({
      state: "stale",
      online: 3,
      maxPlayers: 20,
      names: ["Alex", "Steve", "Zoe"],
      sampledAt: "2026-07-25T09:55:00.000Z",
      lastAttemptAt: "2026-07-25T10:00:00.000Z",
      code: "QUERY_TIMEOUT",
      message: "Query timed out"
    })).toBe(3);
    expect(onlinePlayerCount({ state: "stopped", online: 0, maxPlayers: 20, names: [], sampledAt: "2026-07-25T10:00:00.000Z" })).toBe(0);
    expect(onlinePlayerCount({
      state: "unavailable",
      online: null,
      maxPlayers: null,
      names: [],
      code: "QUERY_DISABLED",
      message: "Query is disabled"
    })).toBe(0);
  });
});

describe("runtimeActionConfirmation", () => {
  it("never confirms starting a server", () => {
    expect(runtimeActionConfirmation("start", "Survival", liveSnapshot(["Alex"]))).toBeNull();
  });

  it("skips confirmation when nobody is online", () => {
    expect(runtimeActionConfirmation("stop", "Survival", liveSnapshot([]))).toBeNull();
    expect(runtimeActionConfirmation("restart", "Survival", undefined)).toBeNull();
  });

  it("confirms a stop with the online player names", () => {
    const confirmation = runtimeActionConfirmation("stop", "Survival", liveSnapshot(["Alex", "Steve"]));
    expect(confirmation).toMatchObject({
      title: "Stop the server with players online?",
      description: "2 players are currently connected to Survival.",
      details: "Alex, Steve",
      confirmLabel: "Stop server",
      cancelLabel: "Keep running",
      variant: "critical"
    });
  });

  it("uses singular wording and a primary restart action", () => {
    const confirmation = runtimeActionConfirmation("restart", "Creative", liveSnapshot(["Alex"]));
    expect(confirmation?.description).toBe("1 player is currently connected to Creative.");
    expect(confirmation?.confirmLabel).toBe("Restart server");
    expect(confirmation?.variant).toBe("primary");
  });

  it("truncates long player lists", () => {
    const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    expect(runtimeActionConfirmation("stop", "Survival", liveSnapshot(names))?.details).toBe("A, B, C, D, E, F, G, H and 2 more");
  });

  it("flags stale player data", () => {
    const confirmation = runtimeActionConfirmation("stop", "Survival", {
      state: "stale",
      online: 4,
      maxPlayers: 20,
      names: ["Alex"],
      sampledAt: "2026-07-25T09:55:00.000Z",
      lastAttemptAt: "2026-07-25T10:00:00.000Z",
      code: "QUERY_TIMEOUT",
      message: "Query timed out"
    });
    expect(confirmation?.description).toBe("4 players are currently connected to Survival. The panel could not refresh the player list, so this count may be out of date.");
    expect(confirmation?.details).toBe("Alex and 3 more");
  });
});
