import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerPlayerInsightsRoutes } from "./playerInsightsRoutes.js";

const serverId = "11111111-1111-4111-8111-111111111111";

function testApp() {
  const app = Fastify();
  const setServerLocation = vi.fn(async (requestedServerId: string, address: string) => ({
    serverId: requestedServerId,
    ...(address ? { address } : {})
  }));
  registerPlayerInsightsRoutes(app, {
    destructiveRateLimit: {},
    requireRequestPermission: vi.fn(async () => undefined),
    insights: vi.fn(async () => ({} as never)),
    setServerLocation,
    refreshGeoDatabase: vi.fn(async () => ({ available: false, configured: false, updating: false })),
    logInfo: vi.fn()
  });
  return { app, setServerLocation };
}

describe("player insights routes", () => {
  it.each([
    ["a missing address", {}],
    ["a null address", { address: null }],
    ["a URL", { address: "https://play.example.net" }],
    ["a host with a port", { address: "play.example.net:25565" }],
    ["an unmatched address bracket", { address: "[2001:db8::1" }],
    ["an overlong address", { address: `${"a".repeat(250)}.com` }]
  ])("rejects %s as a validation error", async (_label, payload) => {
    const harness = testApp();
    const response = await harness.app.inject({ method: "PUT", url: `/api/players/servers/${serverId}/location`, payload });

    expect(response.statusCode).toBe(400);
    expect(harness.setServerLocation).not.toHaveBeenCalled();
    await harness.app.close();
  });

  it("normalizes a configured address and reserves an explicit empty string for clearing it", async () => {
    const harness = testApp();
    const configured = await harness.app.inject({
      method: "PUT",
      url: `/api/players/servers/${serverId}/location`,
      payload: { address: "  PLAY.EXAMPLE.NET  " }
    });
    const cleared = await harness.app.inject({
      method: "PUT",
      url: `/api/players/servers/${serverId}/location`,
      payload: { address: "" }
    });

    expect(configured.statusCode).toBe(200);
    expect(cleared.statusCode).toBe(200);
    expect(harness.setServerLocation).toHaveBeenNthCalledWith(1, serverId, "play.example.net");
    expect(harness.setServerLocation).toHaveBeenNthCalledWith(2, serverId, "");
    await harness.app.close();
  });
});
