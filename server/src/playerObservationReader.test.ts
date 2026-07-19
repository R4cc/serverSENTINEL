import { describe, expect, it, vi } from "vitest";
import { readMinecraftPlayerObservation } from "./playerObservationReader.js";
import type { MinecraftQueryEndpoint } from "./queryEndpoint.js";

function endpoint(host: string, port: number): MinecraftQueryEndpoint {
  return { host, port, source: "container-network", diagnostics: [] };
}

describe("readMinecraftPlayerObservation", () => {
  it("tries resolved fallback endpoints when the preferred query route fails", async () => {
    const queryServer = vi.fn()
      .mockRejectedValueOnce(new Error("recvmsg ECONNREFUSED"))
      .mockResolvedValueOnce({ responding: true, playersOnline: 1, maxPlayers: 20, playerNames: ["Alex"] });

    const observation = await readMinecraftPlayerObservation({
      running: true,
      instanceId: "container:start",
      props: { "enable-query": "true", "max-players": "20" },
      endpoint: endpoint("172.20.0.5", 25566),
      fallbackEndpoints: [endpoint("172.20.0.1", 32566)],
      queryServer,
      now: () => new Date("2026-07-19T12:00:00.000Z")
    });

    expect(queryServer).toHaveBeenNthCalledWith(1, "172.20.0.5", 25566);
    expect(queryServer).toHaveBeenNthCalledWith(2, "172.20.0.1", 32566);
    expect(observation).toEqual({
      state: "live",
      instanceId: "container:start",
      online: 1,
      maxPlayers: 20,
      names: ["Alex"],
      sampledAt: "2026-07-19T12:00:00.000Z"
    });
  });

  it("does not retry duplicate endpoints", async () => {
    const queryServer = vi.fn().mockRejectedValue(new Error("unavailable"));
    const preferred = endpoint("172.20.0.5", 25566);

    const observation = await readMinecraftPlayerObservation({
      running: true,
      instanceId: "container:start",
      props: { "enable-query": "true" },
      endpoint: preferred,
      fallbackEndpoints: [preferred],
      queryServer
    });

    expect(queryServer).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({ state: "unavailable", code: "QUERY_TIMEOUT" });
  });
});
