import { describe, expect, it } from "vitest";
import type { ServerEvent } from "./types.js";
import { inferActivePlayerNames, resolvePlayerNames } from "./playerRoster.js";

function event(eventType: ServerEvent["eventType"], subject?: string, timestamp = "2026-07-15T12:00:00.000Z", source: ServerEvent["source"] = "logs/latest.log"): ServerEvent {
  const action = eventType === "player_joined" ? "joined" : eventType === "player_left" ? "left" : eventType.replace("server_", "");
  const message = subject ? `${subject} ${action}` : `Server ${action}`;
  return {
    id: `${source}-${eventType}-${subject ?? "server"}-${timestamp}`,
    eventType,
    type: eventType === "server_crashed" ? "error" : "info",
    severity: eventType === "server_crashed" ? "error" : "info",
    text: message,
    message,
    timestamp,
    signature: subject ? `${eventType}:${subject.toLowerCase()}` : eventType,
    source,
    subject
  };
}

describe("active player roster inference", () => {
  it("applies joins, leaves, and reconnects chronologically", () => {
    const events = [
      event("player_joined", "Alex", "2026-07-15T12:00:01.000Z"),
      event("player_joined", "Steve", "2026-07-15T12:00:02.000Z"),
      event("player_left", "Alex", "2026-07-15T12:00:03.000Z"),
      event("player_joined", "Alex", "2026-07-15T12:00:04.000Z")
    ];

    expect(inferActivePlayerNames(events, 2)).toEqual(["Steve", "Alex"]);
  });

  it("clears inferred state at server lifecycle boundaries", () => {
    for (const boundary of ["server_started", "server_stopped", "server_crashed"] as const) {
      expect(inferActivePlayerNames([
        event("player_joined", "OldPlayer", "2026-07-15T11:59:59.000Z"),
        event(boundary, undefined, "2026-07-15T12:00:00.000Z"),
        event("player_joined", "CurrentPlayer", "2026-07-15T12:00:01.000Z")
      ], 2)).toEqual(["CurrentPlayer"]);
    }
  });

  it("deduplicates file and Docker copies of the same event", () => {
    const joined = event("player_joined", "Alex", "2026-07-15T12:00:01.000Z");
    expect(inferActivePlayerNames([
      joined,
      { ...joined, id: `docker-${joined.id}`, source: "docker" }
    ], 2)).toEqual(["Alex"]);
  });

  it("caps stale inferred state to the authoritative Query count", () => {
    expect(inferActivePlayerNames([
      event("player_joined", "Alex", "2026-07-15T12:00:01.000Z"),
      event("player_joined", "Steve", "2026-07-15T12:00:02.000Z"),
      event("player_joined", "Sam", "2026-07-15T12:00:03.000Z")
    ], 2)).toEqual(["Steve", "Sam"]);
  });

  it("keeps Query names authoritative and only falls back for a count-only response", () => {
    const events = [event("player_joined", "LogPlayer")];
    expect(resolvePlayerNames([" QueryPlayer ", "QueryPlayer"], events, 2)).toEqual({
      playerNames: ["QueryPlayer"],
      playerNamesSource: "query"
    });
    expect(resolvePlayerNames([], events, 2)).toEqual({
      playerNames: ["LogPlayer"],
      playerNamesSource: "logs"
    });
    expect(resolvePlayerNames(undefined, [], 2)).toEqual({ playerNames: undefined });
  });
});
