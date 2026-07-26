import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { services } from "../appServices.js";
import { appBuildId, appVersion } from "../buildInfo.js";
import { dockerAvailable } from "../docker/dockerClient.js";
import { destructiveRateLimit } from "../http/rateLimits.js";
import { isDemoModeRequest, publicUser, requireRequestPermission } from "../auth/sessionService.js";

import { publicNodes, readNodes } from "../nodes/nodeService.js";
import { listManagedServers } from "../servers/store.js";

import { playerHeadProvider } from "../playerHeadService.js";
import { modrinthApiKey } from "../mods/modService.js";
import { detectedTotalMemory } from "../runtime/local/dockerContainers.js";
import { requireStrictBoolean } from "../http/validation.js";
import { runtimeForServer } from "../appServices.js";
import { logInfo } from "../logging.js";

export function publicPlayerHeadsState(demoMode = false) {
  if (demoMode) {
    return { enabled: false, onboardingRequired: false, provider: playerHeadProvider, cacheEntries: 0, cacheBytes: 0 };
  }
  const settings = services.settingsRepository.get();
  const cache = services.playerHeadService.stats();
  return {
    enabled: settings.playerHeadsEnabled,
    onboardingRequired: !settings.playerHeadsOnboardingCompleted,
    provider: playerHeadProvider,
    cacheEntries: cache.entries,
    cacheBytes: cache.bytes
  };
}

export function registerAppInfoRoutes(app: FastifyInstance) {
app.get("/api/app", async (request) => {
  const demoMode = await isDemoModeRequest(request);
  const user = demoMode ? null : await requireRequestPermission(request, "servers.view");
  if (demoMode) {
    return {
      servers: [],
      nodes: [],
      appVersion,
      buildId: appBuildId,
      runtimeMode: config.runtimeMode,
      timeZone: config.timeZone,
      modrinthApiConfigured: false,
      playerHeads: publicPlayerHeadsState(true),
      dockerSocketMounted: false,
      totalMemory: 0
    };
  }
  const servers = await listManagedServers();
  const nodes = await readNodes();
  const totalMemory = await detectedTotalMemory();
  return {
    servers: await Promise.all(servers.map((server) => runtimeForServer(server).publicServer(server, nodes))),
    nodes: await publicNodes(nodes, totalMemory),
    appVersion,
    buildId: appBuildId,
    runtimeMode: config.runtimeMode,
    timeZone: config.timeZone,
    modrinthApiConfigured: Boolean(await modrinthApiKey()),
    playerHeads: publicPlayerHeadsState(),
    dockerSocketMounted: dockerAvailable(),
    totalMemory,
    currentUser: user ? publicUser(user) : undefined
  };
});

app.get("/api/context", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const servers = await listManagedServers();
  const nodes = await readNodes();
  const publicServers = await Promise.all(servers.map((server) => runtimeForServer(server).publicServer(server, nodes)));
  const publicNodeList = await publicNodes(nodes);
  return {
    nodes: publicNodeList.map((node) => ({
      ...node,
      servers: publicServers.filter((server) => server.nodeId === node.id)
    }))
  };
});

app.put<{ Body: { modrinthApiKey?: string } }>("/api/settings/modrinth", async (request) => {
  await requireRequestPermission(request, "integrations.manage");
  const key = request.body.modrinthApiKey?.trim();
  if (!key) {
    throw new Error("Modrinth API key is required");
  }
  services.settingsRepository.setModrinthApiKey(key);
  logInfo({ action: "configure_modrinth", status: "succeeded" }, "Modrinth API configuration updated");
  return { ok: true, modrinthApiConfigured: true };
});

app.put<{ Body: { enabled?: boolean } }>("/api/settings/player-heads", async (request) => {
  await requireRequestPermission(request, "integrations.manage");
  const enabled = requireStrictBoolean(request.body?.enabled, "enabled");
  services.playerHeadService.setEnabled(enabled);
  logInfo({ action: "configure_player_heads", enabled, status: "succeeded" }, "Player head integration updated");
  return { ok: true, playerHeads: publicPlayerHeadsState() };
});

app.delete("/api/settings/player-heads/cache", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "integrations.manage");
  services.playerHeadService.clearCache();
  logInfo({ action: "clear_player_head_cache", status: "succeeded" }, "Player head cache cleared");
  return { ok: true, playerHeads: publicPlayerHeadsState() };
});

}
