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

function recordingRepository() {
  const records: Array<{ serverId: string; player: string; location: PlayerLocation; at: number }> = [];
  return {
    records,
    repository: {
      record: (entry: { serverId: string; player: string; location: PlayerLocation; at: number }) => { records.push(entry); },
      prune: () => 0
    } as unknown as PlayerGeoRepository
  };
}

function collectorFor(options: {
  logs: string;
  reader?: GeoCityReader;
  repository: PlayerGeoRepository;
  readLogs?: () => Promise<unknown>;
}) {
  return new PlayerGeoCollector({
    readServers: async () => [server],
    readLogs: options.readLogs ?? (async () => ({ text: options.logs })),
    repository: options.repository,
    cityReader: () => options.reader,
    now: () => Date.parse("2026-08-16T12:00:00.000Z")
  });
}

describe("player geography collection", () => {
  const reader: GeoCityReader = { city: () => copenhagen };
  const logs = [
    "[11:59:00] [Server thread/INFO]: SullyTheSnak[/203.0.113.5:51234] logged in with entity id 42",
    "[11:59:05] [Server thread/INFO]: SullyTheSnak joined the game"
  ].join("\n");

  it("stores the place a login resolved to and never the address it resolved from", async () => {
    const { records, repository } = recordingRepository();
    await collectorFor({ logs, reader, repository }).collectAll();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ serverId: "server-1", player: "SullyTheSnak" });
    expect(records[0].location.city).toBe("Copenhagen");
    // The whole privacy claim in one assertion: nothing handed to storage mentions the address.
    expect(JSON.stringify(records[0])).not.toContain("203.0.113.5");
  });

  it("reads no logs at all while there is no database to resolve against", async () => {
    const { records, repository } = recordingRepository();
    const readLogs = vi.fn(async () => ({ text: logs }));
    await collectorFor({ logs, repository, readLogs }).collectAll();

    expect(readLogs).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it("skips a player whose address has no public location", async () => {
    const { records, repository } = recordingRepository();
    await collectorFor({
      logs: "[11:59:00] [Server thread/INFO]: LanPlayer[/192.168.1.40:51234] logged in with entity id 1",
      reader,
      repository
    }).collectAll();

    expect(records).toEqual([]);
  });

  it("keeps polling after a server's logs fail, and reports it once", async () => {
    const { records, repository } = recordingRepository();
    const errors: unknown[] = [];
    const collector = new PlayerGeoCollector({
      readServers: async () => [server],
      readLogs: async () => { throw new Error("node offline"); },
      repository,
      cityReader: () => reader,
      onError: (error) => errors.push(error)
    });
    await collector.collectAll();
    expect(errors).toHaveLength(1);
    expect(records).toEqual([]);
  });

  it("stops collecting once the module switches it off", async () => {
    const { records, repository } = recordingRepository();
    const collector = collectorFor({ logs, reader, repository });
    collector.stop();
    await collector.collectAll();
    expect(records).toEqual([]);
  });
});
