import { describe, expect, it, vi } from "vitest";
import type { PlayerLocation } from "@serversentinel/contracts";
import type { PlayerGeoRepository } from "../storage/playerGeoRepository.js";
import type { ManagedServer } from "../types.js";
import type { GeoCityReader } from "./geoLocation.js";
import { PlayerGeoCollector } from "./playerGeoCollector.js";

const server = { id: "server-1", displayName: "Survival" } as ManagedServer;

const copenhagen = {
  city: { names: { en: "Copenhagen" } },
  country: { isoCode: "DK", names: { en: "Denmark" } },
  continent: { code: "EU", names: { en: "Europe" } },
  location: { latitude: 55.68, longitude: 12.57, accuracyRadius: 20 }
};

const reader: GeoCityReader = { city: () => copenhagen };

const logs = [
  "[11:59:00] [Server thread/INFO]: SullyTheSnak[/203.0.113.5:51234] logged in with entity id 42",
  "[11:59:05] [Server thread/INFO]: SullyTheSnak joined the game"
].join("\n");

function recordingRepository() {
  const records: Array<{ serverId: string; player: string; location: PlayerLocation; at: number }> = [];
  const pruned: number[] = [];
  return {
    records,
    pruned,
    repository: {
      record: (entry: { serverId: string; player: string; location: PlayerLocation; at: number }) => { records.push(entry); },
      prune: (cutoff: number) => { pruned.push(cutoff); return 0; }
    } as unknown as PlayerGeoRepository
  };
}

/** Stands in for the timeline collector: hands out a subscription and can drive one pass. */
function fakeLogSource() {
  const observers = new Set<(input: { server: ManagedServer; text: string }) => void | Promise<void>>();
  return {
    get subscribers() {
      return observers.size;
    },
    observeLogs(observer: (input: { server: ManagedServer; text: string }) => void | Promise<void>) {
      observers.add(observer);
      return () => { observers.delete(observer); };
    },
    async emit(text: string) {
      for (const observer of [...observers]) await observer({ server, text });
    }
  };
}

function collectorFor(source: ReturnType<typeof fakeLogSource>, options: {
  repository: PlayerGeoRepository;
  reader?: GeoCityReader;
  readServers?: () => Promise<ManagedServer[]>;
  retainServers?: (serverIds: string[]) => void;
  now?: () => number;
}) {
  return new PlayerGeoCollector({
    observeLogs: (observer) => source.observeLogs(observer),
    repository: options.repository,
    cityReader: () => options.reader,
    readServers: options.readServers,
    retainServers: options.retainServers,
    now: options.now ?? (() => Date.parse("2026-08-16T12:00:00.000Z"))
  });
}

describe("player geography collection", () => {
  it("reads the console output the panel already fetched instead of fetching its own", () => {
    const source = fakeLogSource();
    const { repository } = recordingRepository();
    const collector = collectorFor(source, { repository, reader });

    expect(source.subscribers).toBe(0);
    collector.start();
    expect(source.subscribers).toBe(1);
    // Starting twice must not double-subscribe, which would record every login twice.
    collector.start();
    expect(source.subscribers).toBe(1);
  });

  it("stores the place a login resolved to and never the address it resolved from", async () => {
    const source = fakeLogSource();
    const { records, repository } = recordingRepository();
    collectorFor(source, { repository, reader }).start();
    await source.emit(logs);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ serverId: "server-1", player: "SullyTheSnak" });
    expect(records[0].location.city).toBe("Copenhagen");
    // The whole privacy claim in one assertion: nothing handed to storage mentions the address.
    expect(JSON.stringify(records[0])).not.toContain("203.0.113.5");
  });

  it("looks at nothing while there is no database to resolve against", async () => {
    const source = fakeLogSource();
    const { records, repository } = recordingRepository();
    collectorFor(source, { repository }).start();
    await source.emit(logs);

    expect(records).toEqual([]);
  });

  it("shares the parsed login endpoint with the in-memory ping tracker even without a geography database", async () => {
    const source = fakeLogSource();
    const { repository } = recordingRepository();
    const observeLogin = vi.fn();
    const collector = new PlayerGeoCollector({
      observeLogs: (observer) => source.observeLogs(observer),
      repository,
      cityReader: () => undefined,
      observeLogin
    });
    collector.start();
    await source.emit(logs);

    expect(observeLogin).toHaveBeenCalledTimes(1);
    expect(observeLogin).toHaveBeenCalledWith(server, expect.objectContaining({
      player: "SullyTheSnak",
      address: "203.0.113.5",
      port: 51234
    }));
  });

  it("skips a player whose address has no public location", async () => {
    const source = fakeLogSource();
    const { records, repository } = recordingRepository();
    collectorFor(source, { repository, reader }).start();
    await source.emit("[11:59:00] [Server thread/INFO]: LanPlayer[/192.168.1.40:51234] logged in with entity id 1");

    expect(records).toEqual([]);
  });

  it("unsubscribes on stop, so a switched-off module never sees another login line", async () => {
    const source = fakeLogSource();
    const { records, repository } = recordingRepository();
    const collector = collectorFor(source, { repository, reader });

    collector.start();
    collector.stop();
    expect(source.subscribers).toBe(0);
    await source.emit(logs);
    expect(records).toEqual([]);
  });

  it("survives repeated start and stop without leaking subscriptions or double-recording", async () => {
    const source = fakeLogSource();
    const { records, repository } = recordingRepository();
    const collector = collectorFor(source, { repository, reader });

    for (let cycle = 0; cycle < 5; cycle += 1) {
      collector.start();
      collector.stop();
    }
    expect(source.subscribers).toBe(0);

    collector.start();
    expect(source.subscribers).toBe(1);
    await source.emit(logs);
    expect(records).toHaveLength(1);
  });

  it("reports a failure once and keeps the subscription", async () => {
    const source = fakeLogSource();
    const errors: unknown[] = [];
    const collector = new PlayerGeoCollector({
      observeLogs: (observer) => source.observeLogs(observer),
      repository: { record: () => { throw new Error("disk is full"); }, prune: () => 0 } as unknown as PlayerGeoRepository,
      cityReader: () => reader,
      onError: (error) => errors.push(error)
    });
    collector.start();
    await source.emit(logs);

    expect(errors).toHaveLength(1);
    expect(source.subscribers).toBe(1);
  });

  it("prunes and forgets deleted servers at most once an hour, not once a pass", async () => {
    const source = fakeLogSource();
    const { pruned, repository } = recordingRepository();
    const retained: string[][] = [];
    let now = Date.parse("2026-08-16T12:00:00.000Z");
    collectorFor(source, {
      repository,
      reader,
      readServers: async () => [server],
      retainServers: (serverIds) => retained.push(serverIds),
      now: () => now
    }).start();

    await source.emit(logs);
    await source.emit(logs);
    expect(pruned).toHaveLength(1);
    expect(retained).toEqual([["server-1"]]);

    now += 61 * 60 * 1000;
    await source.emit(logs);
    expect(pruned).toHaveLength(2);
    expect(retained).toHaveLength(2);
  });

  it("prunes against its retention window rather than the current instant", async () => {
    const source = fakeLogSource();
    const { pruned, repository } = recordingRepository();
    const now = Date.parse("2026-08-16T12:00:00.000Z");
    collectorFor(source, { repository, reader, now: () => now }).start();
    await source.emit(logs);

    expect(pruned[0]).toBeLessThan(now);
    expect(now - pruned[0]).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("ignores an empty log window without touching storage", async () => {
    const source = fakeLogSource();
    const { records, pruned, repository } = recordingRepository();
    const cityReader = vi.fn(() => reader);
    new PlayerGeoCollector({
      observeLogs: (observer) => source.observeLogs(observer),
      repository,
      cityReader
    }).start();
    await source.emit("");

    expect(records).toEqual([]);
    expect(pruned).toEqual([]);
    expect(cityReader).not.toHaveBeenCalled();
  });
});
