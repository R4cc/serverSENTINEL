import { describe, expect, it } from "vitest";
import { createDemoSession, demoConsoleMessages, demoFleetNodes, demoFleetServers, demoPlayerSnapshot, demoPlayerSnapshots, demoStats, demoStatsHistory, demoTimelineData, initialDemoSchedules } from "./demo";
import { resourceHistorySampleLimit, resourcePollMs } from "./utils/format";

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("demo resource statistics", () => {
  it("starts with a full hour of samples for screenshot-ready graphs", () => {
    const now = Date.now();
    const samples = demoStatsHistory(true, now, resourcePollMs, resourceHistorySampleLimit);

    expect(samples).toHaveLength(resourceHistorySampleLimit);
    expect(samples[0].sampledAt).toBe(now - 60 * 60 * 1000);
    expect(samples.at(-1)?.sampledAt).toBe(now);
    expect(samples.every((sample) => sample.available && sample.running)).toBe(true);
    expect(samples.every((sample, index) => index === 0 || sample.sampledAt - samples[index - 1].sampledAt === resourcePollMs)).toBe(true);
  });

  it("keeps the generated player count and resource values in realistic bounds", () => {
    const snapshot = demoPlayerSnapshot(true);
    const sample = demoStats(true);

    expect(snapshot.online).toBeGreaterThanOrEqual(10);
    expect(snapshot.online).toBeLessThanOrEqual(40);
    expect(snapshot.names).toHaveLength(snapshot.online ?? 0);
    expect(new Set(snapshot.names).size).toBe(snapshot.names.length);
    expect(snapshot.names.every((name) => /^[A-Za-z0-9_]{3,16}$/.test(name))).toBe(true);
    expect(sample.playersOnline).toBe(snapshot.online);
    expect(sample.cpuPercent / (sample.cpuCapacityCores ?? 1)).toBeGreaterThanOrEqual(5);
    expect(sample.cpuPercent / (sample.cpuCapacityCores ?? 1)).toBeLessThanOrEqual(85);
    expect(sample.memoryUsageBytes).toBeGreaterThanOrEqual(1.1 * 1024 ** 3);
    expect(sample.memoryUsageBytes).toBeLessThanOrEqual(3.6 * 1024 ** 3);
  });
});

describe("demo session generation", () => {
  it("populates a multi-node fleet with hundreds of distributed players", () => {
    const nodes = demoFleetNodes();
    const servers = demoFleetServers();
    const snapshots = demoPlayerSnapshots(true);
    const players = Object.values(snapshots).reduce((total, snapshot) => total + (snapshot.online ?? 0), 0);

    expect(nodes).toHaveLength(8);
    expect(servers).toHaveLength(32);
    expect(new Set(servers.map((server) => server.nodeId))).toEqual(new Set(nodes.map((node) => node.id)));
    expect(Object.keys(snapshots)).toHaveLength(servers.length);
    expect(players).toBeGreaterThanOrEqual(320);
  });

  it("creates a fresh randomized roster, resource profile, and event mix", () => {
    const first = createDemoSession(seededRandom(1), 1_000_000);
    const second = createDemoSession(seededRandom(2), 1_000_000);

    expect(first.onlinePlayerNames).not.toEqual(second.onlinePlayerNames);
    expect(first.timelineScenarioPlayers).not.toEqual(second.timelineScenarioPlayers);
    expect(first.cpuBasePercent).not.toBe(second.cpuBasePercent);
    expect(first.memoryBaseBytes).not.toBe(second.memoryBaseBytes);
    expect(first.events.map((event) => event.eventType)).not.toEqual(second.events.map((event) => event.eventType));
    expect(first.events).toHaveLength(11);
    expect(first.events.some((event) => event.eventType === "player_joined")).toBe(true);
    expect(first.events.some((event) => event.eventType === "player_left")).toBe(true);
    expect(first.events.every((event) => event.occurredAt <= first.startedAt)).toBe(true);
    expect([...first.onlinePlayerNames, ...first.offlinePlayerNames].every((name) => !name.toLowerCase().includes("alex"))).toBe(true);
  });

  it("uses the randomized nicknames in timeline player activity and events", () => {
    const now = Date.now();
    const snapshot = demoPlayerSnapshot(true);
    const timeline = demoTimelineData(true, initialDemoSchedules, now - 60 * 60_000, now);
    const knownNames = new Set([
      ...timeline.playerActivity?.onlineNames ?? [],
      ...timeline.playerActivity?.sessions.map((session) => session.player) ?? []
    ]);

    expect(timeline.playerActivity?.onlineNames).toEqual(snapshot.names);
    expect(timeline.events.filter((event) => event.subject && event.eventType.startsWith("player_"))
      .every((event) => knownNames.has(event.subject!))).toBe(true);
  });

  it("includes deterministic marathon, reconnect, and instant-session scenarios", () => {
    const now = Date.now();
    const timeline = demoTimelineData(true, initialDemoSchedules, now - 24 * 60 * 60_000, now);
    const generatedAt = new Date(timeline.generatedAt).getTime();
    const sessions = timeline.playerActivity?.sessions ?? [];
    const marathon = sessions.find((session) => session.startedAt === generatedAt - 25 * 60 * 60_000 && session.endedAt === null);
    const reconnectPlayer = sessions.find((session, index) => sessions.some((candidate, candidateIndex) => (
      candidateIndex !== index && candidate.player === session.player
    )))?.player;
    const reconnect = sessions.filter((session) => session.player === reconnectPlayer)
      .sort((left, right) => left.startedAt - right.startedAt);
    const blink = sessions.find((session) => session.endedAt !== null && session.endedAt - session.startedAt === 5_000);

    expect(marathon).toMatchObject({
      startedAt: generatedAt - 25 * 60 * 60_000,
      endedAt: null,
      startBoundary: "join",
      endBoundary: "online"
    });
    expect(reconnect).toHaveLength(2);
    expect(reconnect[1].startedAt - reconnect[0].endedAt!).toBe(7_000);
    expect(blink?.endedAt! - blink?.startedAt!).toBe(5_000);
  });

  it("uses only the active randomized roster in demo console messages", () => {
    const names = demoPlayerSnapshot(true).names;
    const messages = demoConsoleMessages().join("\n");

    expect(names.slice(0, 2).every((name) => messages.includes(name))).toBe(true);
    expect(messages.toLowerCase()).not.toContain("alex");
  });
});
