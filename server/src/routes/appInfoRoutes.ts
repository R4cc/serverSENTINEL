import type { FastifyInstance } from "fastify";
import { moduleAccessStates } from "@serversentinel/contracts";
import { config } from "../config.js";
import { services } from "../appServices.js";
import { appBuildId, appVersion } from "../buildInfo.js";
import { dockerReachable } from "../docker/dockerClient.js";
import { destructiveRateLimit } from "../http/rateLimits.js";
import { throwHttp } from "../http/errors.js";
import { isDemoModeRequest, publicUser, requireRequestPermission } from "../auth/sessionService.js";

import { publicNodes, readNodes } from "../nodes/nodeService.js";
import { listManagedServers } from "../servers/store.js";

import { playerHeadProvider } from "../playerHeadService.js";
import { modrinthApiKey } from "../mods/modService.js";
import { detectedTotalMemory } from "../runtime/local/dockerContainers.js";
import { requireStrictBoolean } from "../http/validation.js";
import { runtimeForServer } from "../appServices.js";
import { logInfo } from "../logging.js";
import { completeOnboarding, onboardingCurrentVersion, publicOnboardingState } from "../onboarding.js";

/** Whether a GeoLite2 download can be authorized at all, from Settings or from the environment. */
function maxmindConfigured() {
  const settings = services.settingsRepository.get();
  return Boolean((settings.maxmindAccountId ?? config.maxmindAccountId) && (settings.maxmindLicenseKey ?? config.maxmindLicenseKey));
}

function publicPlayerHeadsState(demoMode = false) {
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
      geoIpConfigured: false,
      playerHeads: publicPlayerHeadsState(true),
      // The demo replaces this installation's data, not its configuration: a module the operator
      // switched off is absent from the demo too, and the demo account reaches every module that
      // is on. Reporting them all as present would make the Modules settings lie in demo mode.
      modules: moduleAccessStates({ isEnabled: (id) => services.moduleRegistry.isEnabled(id), hasPermission: () => true }),
      onboarding: { currentVersion: onboardingCurrentVersion, completedVersion: onboardingCurrentVersion },
      dockerSocketMounted: false,
      totalMemory: 0
    };
  }
  const servers = await listManagedServers();
  const nodes = await readNodes();
  const dockerSocketMounted = await dockerReachable();
  const totalMemory = await detectedTotalMemory();
  return {
    servers: await Promise.all(servers.map((server) => runtimeForServer(server).publicServer(server, nodes, servers))),
    nodes: await publicNodes(nodes, totalMemory),
    appVersion,
    buildId: appBuildId,
    runtimeMode: config.runtimeMode,
    timeZone: config.timeZone,
    modrinthApiConfigured: Boolean(await modrinthApiKey()),
    geoIpConfigured: maxmindConfigured(),
    playerHeads: publicPlayerHeadsState(),
    modules: services.moduleRegistry.states(user),
    onboarding: publicOnboardingState(services.storageDatabase),
    dockerSocketMounted,
    totalMemory,
    currentUser: user ? publicUser(user) : undefined
  };
});

app.get("/api/context", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const servers = await listManagedServers();
  const nodes = await readNodes();
  const publicServers = await Promise.all(servers.map((server) => runtimeForServer(server).publicServer(server, nodes, servers)));
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

/**
 * MaxMind credentials, kept alongside the Modrinth key because they are the same kind of thing: a
 * third-party account this installation holds, entered once and never read back. They authorize the
 * GeoLite2 download and nothing else — no player data is ever sent to MaxMind — so the API reports
 * only whether a pair is configured, never the pair itself.
 */
app.put<{ Body: { accountId?: string; licenseKey?: string } }>("/api/settings/maxmind", async (request) => {
  await requireRequestPermission(request, "integrations.manage");
  const accountId = request.body?.accountId?.trim() ?? "";
  const licenseKey = request.body?.licenseKey?.trim() ?? "";
  if (Boolean(accountId) !== Boolean(licenseKey)) {
    throwHttp(400, "MaxMind needs both an account ID and a license key, or neither to clear them.");
  }
  if (accountId && !/^\d{1,20}$/.test(accountId)) throwHttp(400, "The MaxMind account ID is a number.");
  if (licenseKey.length > 128) throwHttp(400, "That does not look like a MaxMind license key.");
  services.settingsRepository.setMaxmindCredentials(accountId, licenseKey);
  logInfo({ action: "configure_maxmind", configured: Boolean(accountId), status: "succeeded" }, "MaxMind GeoLite2 configuration updated");
  return { ok: true, geoIpConfigured: maxmindConfigured() };
});

app.put<{ Body: { enabled?: boolean } }>("/api/settings/player-heads", async (request) => {
  await requireRequestPermission(request, "integrations.manage");
  const enabled = requireStrictBoolean(request.body?.enabled, "enabled");
  services.playerHeadService.setEnabled(enabled);
  logInfo({ action: "configure_player_heads", enabled, status: "succeeded" }, "Player head integration updated");
  return { ok: true, playerHeads: publicPlayerHeadsState() };
});

app.put("/api/settings/onboarding/complete", async (request) => {
  await requireRequestPermission(request, "users.manage");
  const onboarding = completeOnboarding(services.storageDatabase);
  logInfo({ action: "complete_onboarding", onboardingVersion: onboarding.completedVersion, status: "succeeded" }, "Initial onboarding completed");
  return { ok: true, onboarding };
});

app.delete("/api/settings/player-heads/cache", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "integrations.manage");
  services.playerHeadService.clearCache();
  logInfo({ action: "clear_player_head_cache", status: "succeeded" }, "Player head cache cleared");
  return { ok: true, playerHeads: publicPlayerHeadsState() };
});

}
