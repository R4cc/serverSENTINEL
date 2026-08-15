import type { FastifyInstance } from "fastify";
import { runtimeForServer, services } from "../appServices.js";
import { durationSince, errorLogFields, logDebug, logError, logInfo } from "../logging.js";
import { apiErrorResponse, throwHttp } from "../http/errors.js";
import { modChangeRateLimit } from "../http/rateLimits.js";
import { multipartUpload } from "../http/multipart.js";
import { optionalCompatibilityFilter, optionalReleaseChannel, validateModrinthProjectId } from "../http/validation.js";
import { requireRequestPermission } from "../auth/sessionService.js";
import { asArray, requiredString } from "../storage/valueValidation.js";
import { safeInstalledModFilename } from "../core.js";
import { getServer } from "../servers/store.js";
import { publicInstalledModsResult } from "../servers/publicViews.js";
import { managedContentRuntime, requireManagedModsRuntime } from "../servers/versions.js";
import { recordOperation } from "../servers/lifecycle.js";
import { serverLogFields } from "../runtime/local/dockerContainers.js";
import { runtimeTarget } from "../runtime/profile.js";
import { searchModrinth } from "../modrinth/searchCache.js";
import { executeSafeUpdatePlan } from "../modrinth/updatePlan.js";
import { allowedForChannel, fetchProject, fetchProjects, fetchProjectVersions, minecraftVersionsInclude, modrinthJarFile, modrinthServerSideSupported, unknownCompatibility } from "../modrinth/compatibility.js";
import { fetchModrinthIcon, modrinthIconProxyUrl } from "../mods/icons.js";
import { modFileSizeLimit, withModMutationLock } from "../mods/managedContent.js";
import { acknowledgeInstalledModReview, buildModUpdatePlan, classifyModrinthInstallVersion, enrichInstalledModDependencies, installModWithRemoteVersionFallback, listModsWithPanelMetadata, modrinthSearchFacets, modsFromListResult, remoteModMetadata, switchModrinthModVersion, updateModrinthMod, withTrackedModMutation } from "../mods/modService.js";
import type { ModrinthProject, ReleaseChannel } from "../types.js";

/**
 * The cached update plan is published by the managed-content module's runtime. These routes only
 * answer while that module is enabled, so its absence means the runtime has not finished starting
 * rather than a configuration the caller can fix.
 */
function updatePlanCoordinator() {
  const coordinator = services.modUpdatePlanCoordinator;
  if (!coordinator) {
    throwHttp(503, "The managed content module is still starting. Try again in a moment.", { code: "MODULE_STARTING" });
  }
  return coordinator;
}

export function registerModRoutes(app: FastifyInstance) {
app.get<{ Params: { id: string }; Querystring: { forceRefresh?: string } }>("/api/servers/:id/mods", async (request) => {
  await requireRequestPermission(request, "mods.view");
  const server = await getServer(request.params.id);
  requireManagedModsRuntime(server);
  const options = { forceRefresh: request.query.forceRefresh === "true" };
  const listed = await listModsWithPanelMetadata(server, options);
  return publicInstalledModsResult(await enrichInstalledModDependencies(listed, { fetchMetadata: options.forceRefresh }));
});

app.get<{ Params: { id: string }; Querystring: { forceRefresh?: string; channel?: ReleaseChannel } }>("/api/servers/:id/mods/update-plan", async (request) => {
  await requireRequestPermission(request, "mods.view");
  const server = await getServer(request.params.id);
  requireManagedModsRuntime(server);
  const channel = optionalReleaseChannel(request.query.channel);
  if (channel) return buildModUpdatePlan(server, { forceRefresh: request.query.forceRefresh === "true", channel });
  if (request.query.forceRefresh === "true") return updatePlanCoordinator().refresh(server);
  return updatePlanCoordinator().get(server.id);
});

app.get<{ Params: { id: string }; Querystring: { filename?: string; v?: string } }>("/api/servers/:id/mods/icon", async (request, reply) => {
  await requireRequestPermission(request, "mods.view");
  const server = await getServer(request.params.id);
  requireManagedModsRuntime(server);
  const icon = await runtimeForServer(server).modIcon(server, request.query.filename);
  if (!icon) {
    reply.code(404);
    return apiErrorResponse("ICON_NOT_FOUND", "Icon not found");
  }
  reply.header("Content-Type", icon.contentType);
  reply.header("Cache-Control", "public, max-age=604800, immutable");
  return reply.send(icon.stream);
});

app.get<{ Querystring: { url?: string } }>("/api/modrinth/icon", async (request, reply) => {
  await requireRequestPermission(request, "mods.view");
  const icon = await fetchModrinthIcon(request.query.url);
  reply.header("Content-Type", icon.contentType);
  reply.header("Cache-Control", "public, max-age=86400");
  return reply.send(icon.bytes);
});

app.patch<{ Params: { id: string }; Body: { filename?: string; enabled?: boolean } }>("/api/servers/:id/mods", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.enableDisable");
  const server = await getServer(request.params.id);
  requireManagedModsRuntime(server);
  const { singular: contentName, Singular } = managedContentRuntime(server);
  return withTrackedModMutation(server, () => recordOperation({
    type: "mod.toggle",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: `Updating ${contentName} state`,
    successTask: `${Singular} state updated`
  }, () => runtimeForServer(server).toggleMod(server, request.body.filename, request.body.enabled)));
});

app.delete<{ Params: { id: string }; Querystring: { filename?: string } }>("/api/servers/:id/mods", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.remove");
  const server = await getServer(request.params.id);
  requireManagedModsRuntime(server);
  const { singular: contentName, Singular } = managedContentRuntime(server);
  return withTrackedModMutation(server, () => recordOperation({
    type: "mod.remove",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: `Removing ${contentName}`,
    successTask: `${Singular} removed`
  }, () => runtimeForServer(server).removeMod(server, request.query.filename)));
});

app.post<{ Params: { id: string } }>("/api/servers/:id/mods/upload", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.upload");
  const server = await getServer(request.params.id);
  requireManagedModsRuntime(server);
  const { singular: contentName, Singular } = managedContentRuntime(server);
  if (!request.isMultipart()) throw new Error("Mod and plugin uploads require multipart form data");
  const uploadRequest = await multipartUpload(request, modFileSizeLimit);
  return withTrackedModMutation(server, () => recordOperation({
    type: "mod.upload",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: `Uploading ${contentName}`,
    successTask: `${Singular} uploaded`
  }, () => runtimeForServer(server).uploadMod(server, uploadRequest.filename, uploadRequest.content)));
});

app.post<{ Body: { serverId?: string; projectId?: string; versionId?: string; channel?: ReleaseChannel; forceIncompatible?: boolean; overrideMinecraftVersion?: boolean } }>("/api/modrinth/install", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.install");
  const server = await getServer(request.body.serverId);
  requireManagedModsRuntime(server);
  const { singular: contentName, Singular } = managedContentRuntime(server);
  return withTrackedModMutation(server, () => recordOperation({
    type: "mod.install",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: `Installing ${contentName}`,
    successTask: `${Singular} installed`
  }, () => installModWithRemoteVersionFallback(server, request.body)));
});

app.post<{ Params: { id: string }; Body: { filename?: string } }>("/api/servers/:id/mods/install-dependencies", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.install");
  const server = await getServer(request.params.id);
  requireManagedModsRuntime(server);
  const filename = safeInstalledModFilename(requiredString(request.body.filename, "filename"));
  return withTrackedModMutation(server, () => recordOperation({
    type: "mod.install",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Installing mod dependencies",
    successTask: "Mod dependencies installed"
  }, async () => {
    const listed = await enrichInstalledModDependencies(await listModsWithPanelMetadata(server, { forceRefresh: true }));
    const mods = modsFromListResult(listed);
    const current = mods.find((mod) => mod.filename === filename);
    const metadata = remoteModMetadata(current?.modrinth);
    if (!current || !metadata) throw new Error("Installed Modrinth metadata could not be found for that mod");
    const health = current.dependencyHealth as { status?: string; missing?: Array<{ projectId?: string; versionId?: string; disabled?: boolean }> } | undefined;
    if (!health || health.status === "unknown") throw new Error("Required dependencies could not be resolved from Modrinth");
    if (health.status === "satisfied" || !health.missing?.length) return { ok: true, installed: [], enabled: [], alreadySatisfied: true };

    const runtime = runtimeForServer(server);
    const enabled: string[] = [];
    try {
      for (const dependency of health.missing.filter((item) => item.disabled)) {
        const disabledMod = mods.find((mod) => {
          const candidate = remoteModMetadata(mod.modrinth);
          return mod.enabled === false && ((dependency.projectId && candidate?.projectId === dependency.projectId) || (dependency.versionId && candidate?.versionId === dependency.versionId));
        });
        if (!disabledMod || typeof disabledMod.filename !== "string") continue;
        const toggled = await runtime.toggleMod(server, disabledMod.filename, true) as { filename?: string };
        enabled.push(toggled.filename || disabledMod.filename.replace(/\.disabled$/, ""));
      }
      const result = await installModWithRemoteVersionFallback(server, {
        projectId: metadata.projectId,
        versionId: metadata.versionId,
        channel: typeof current.preferredChannel === "string" ? current.preferredChannel : metadata.versionType,
        dependenciesOnly: true
      }) as { installed?: unknown[] };
      return { ok: true, installed: result.installed ?? [], enabled, alreadySatisfied: false };
    } catch (error) {
      await Promise.allSettled(enabled.map((enabledFilename) => runtime.toggleMod(server, enabledFilename, false)));
      throw error;
    }
  }));
});
app.get<{ Params: { projectId: string }; Querystring: { serverId?: string; channel?: ReleaseChannel } }>("/api/modrinth/projects/:projectId/versions", async (request) => {
  await requireRequestPermission(request, "mods.view");
  const projectId = validateModrinthProjectId(request.params.projectId);
  const server = await getServer(request.query.serverId);
  requireManagedModsRuntime(server);
  const targetRuntime = runtimeTarget(server);
  const contentDefinition = managedContentRuntime(server);
  if (!targetRuntime.minecraftVersion) {
    throw new Error(`A resolved ${contentDefinition.definition.displayName} runtime profile is required before reviewing ${contentDefinition.singular} versions`);
  }
  const selectedChannel = optionalReleaseChannel(request.query.channel);
  const startedAt = Date.now();
  logDebug({ ...serverLogFields(server), projectId, channel: selectedChannel, action: "modrinth_project_versions" }, "Modrinth project versions started");

  try {
    const [project, versions] = await Promise.all([
      fetchProject(projectId),
      fetchProjectVersions(projectId)
    ]);
    const allowedVersions = versions.filter((version) => allowedForChannel(version, selectedChannel));
    const dependencyProjectIds = Array.from(new Set(allowedVersions.flatMap((version) => (
      version.dependencies ?? []
    )).map((dependency) => dependency.project_id).filter((id): id is string => Boolean(id)))).slice(0, 40);
    const dependencyProjects = new Map<string, ModrinthProject>();
    try {
      for (const [dependencyProjectId, dependencyProject] of await fetchProjects(dependencyProjectIds)) {
        dependencyProjects.set(dependencyProjectId, dependencyProject);
      }
    } catch {
      // Dependency names are helpful for the modal, but should not block version selection.
    }
    const projectSides = {
      server_side: project.server_side,
      client_side: project.client_side
    };
    const firstCompatibleId = allowedVersions.find((version) => (
      version.loaders.some((loader) => contentDefinition.loaders.includes(loader))
      && minecraftVersionsInclude(version.game_versions, targetRuntime.minecraftVersion!)
      && modrinthJarFile(version)
      && modrinthServerSideSupported(project.server_side)
    ))?.id;
    const classified = allowedVersions.map((version) => classifyModrinthInstallVersion({
      version,
      minecraftVersion: targetRuntime.minecraftVersion!,
      projectSides,
      recommended: version.id === firstCompatibleId,
      dependencyProjects,
      loaders: contentDefinition.loaders,
      runtimeName: contentDefinition.definition.displayName,
      contentKind: contentDefinition.singular
    }));
    const compatibleVersions = classified.filter((version) => version.compatible);
    const otherVersions = classified.filter((version) => !version.compatible);

    logInfo({ ...serverLogFields(server), projectId, resultCount: classified.length, dependencyProjectCount: dependencyProjectIds.length, dependencyLookup: dependencyProjectIds.length > 0 ? "batch" : "none", durationMs: durationSince(startedAt), action: "modrinth_project_versions", status: "versions_found" }, "Modrinth project versions completed");
    return {
      project: {
        id: projectId,
        title: project.title,
        description: project.description,
        iconUrl: modrinthIconProxyUrl(project.icon_url),
        clientSide: project.client_side,
        serverSide: project.server_side
      },
      target: {
        serverId: server.id,
        serverName: server.displayName,
        minecraftVersion: targetRuntime.minecraftVersion,
        loader: contentDefinition.definition.displayName
      },
      channel: selectedChannel,
      compatibleVersions,
      otherVersions
    };
  } catch (error) {
    logError({ ...serverLogFields(server), projectId, durationMs: durationSince(startedAt), action: "modrinth_project_versions", status: "failed", ...errorLogFields(error) }, "Modrinth project versions failed");
    throw error;
  }
});

app.get<{ Querystring: { query?: string; serverId?: string; channel?: ReleaseChannel; compatibility?: string; offset?: string; limit?: string } }>("/api/modrinth/search", async (request) => {
  await requireRequestPermission(request, "mods.view");
  const query = request.query.query?.trim();
  if (!query) {
    return { hits: [], status: "no_project_found" };
  }
  const server = await getServer(request.query.serverId);
  requireManagedModsRuntime(server);
  const targetRuntime = runtimeTarget(server);
  const contentDefinition = managedContentRuntime(server);
  if (!targetRuntime.minecraftVersion) {
    throw new Error(`A resolved ${contentDefinition.definition.displayName} runtime profile is required before searching compatible ${contentDefinition.plural}`);
  }
  const minecraftVersion = targetRuntime.minecraftVersion;
  const selectedChannel = optionalReleaseChannel(request.query.channel);
  const compatibilityFilter = optionalCompatibilityFilter(request.query.compatibility);
  const startedAt = Date.now();
  logDebug({ ...serverLogFields(server), queryLength: query.length, channel: selectedChannel, compatibilityFilter, action: "modrinth_search" }, "Modrinth search started");

  try {
    const url = new URL("https://api.modrinth.com/v2/search");
    url.searchParams.set("query", query);
    const parsedLimit = request.query.limit ? parseInt(request.query.limit, 10) : 20;
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 20) : 20;
    url.searchParams.set("limit", String(limit));
    let offset = 0;
    if (request.query.offset) {
      const parsedOffset = parseInt(request.query.offset, 10);
      if (Number.isFinite(parsedOffset) && parsedOffset > 0) {
        offset = parsedOffset;
      }
    }
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("facets", JSON.stringify(modrinthSearchFacets(contentDefinition.loaders, minecraftVersion, compatibilityFilter ?? "compatible", contentDefinition.definition.modrinthProjectType)));
    const searchResponse = await searchModrinth(url.toString());
    let body = searchResponse.body;
    const compatibility = (hit: ModrinthProject) => {
      const loaderMatches = hit.categories?.some((loader) => contentDefinition.loaders.includes(loader)) === true;
      const versionMatches = minecraftVersionsInclude(hit.versions ?? [], minecraftVersion);
      const serverMatches = modrinthServerSideSupported(hit.server_side);
      return { loaderMatches, versionMatches, serverMatches, compatible: loaderMatches && versionMatches && serverMatches };
    };
    const searchableHits = (body.hits ?? []).filter((hit) => {
      const projectTypes = hit.all_project_types ?? (hit.project_type ? [hit.project_type] : []);
      return projectTypes.length === 0 || projectTypes.includes(contentDefinition.definition.modrinthProjectType);
    });
    const filtered = searchableHits.filter((hit) => {
      const match = compatibility(hit);
      if (compatibilityFilter === "all") return true;
      if (compatibilityFilter === "compatible") return match.compatible;
      if (compatibilityFilter === "incompatible") return !match.compatible;
      return match.compatible;
    });
    body = { ...body, hits: filtered, offset, limit };
    const hits = (body.hits ?? []).map((hit) => {
      const projectId = hit.project_id || hit.id;
      const serverSide = hit.server_side;
      const loaderMatches = hit.categories?.some((loader) => contentDefinition.loaders.includes(loader)) === true;
      const versionMatches = minecraftVersionsInclude(hit.versions ?? [], minecraftVersion);
      const serverSupported = modrinthServerSideSupported(serverSide);
      const compatible = loaderMatches && versionMatches && serverSupported;
      if (!projectId) {
        return {
          ...hit,
          compatibility: unknownCompatibility()
        };
      }
      return {
        ...hit,
        project_id: projectId,
        icon_url: modrinthIconProxyUrl(hit.icon_url),
        compatibility: compatible
          ? {
              status: "compatible",
              compatible: true,
              reason: `Matches this ${contentDefinition.definition.displayName} server search`,
              matchedLoaders: contentDefinition.loaders,
              matchedGameVersions: [minecraftVersion],
              serverSide,
              clientSide: hit.client_side
            }
          : loaderMatches && versionMatches && serverSide === "unknown"
            ? {
                status: "unknown",
                compatible: false,
                reason: "Server-side support could not be verified",
                matchedLoaders: contentDefinition.loaders,
                matchedGameVersions: [minecraftVersion],
                serverSide,
                clientSide: hit.client_side
              }
            : {
                status: "incompatible",
                compatible: false,
                reason: !loaderMatches
                  ? `No ${contentDefinition.definition.displayName}-compatible release was found for this project`
                  : !versionMatches
                    ? `No release was found for Minecraft ${minecraftVersion}`
                    : `Client-only ${contentDefinition.singular}; server-side support is unsupported`,
                matchedLoaders: contentDefinition.loaders,
                matchedGameVersions: [minecraftVersion],
                serverSide,
                clientSide: hit.client_side
              }
      };
    });
    logInfo({ ...serverLogFields(server), resultCount: hits.length, cacheStatus: searchResponse.cacheStatus, durationMs: durationSince(startedAt), action: "modrinth_search", status: hits.length > 0 ? "projects_found" : "no_project_found" }, "Modrinth search completed");
    return { ...body, hits, status: hits.length > 0 ? "projects_found" : "no_project_found" };
  } catch (error) {
    logError({ ...serverLogFields(server), durationMs: durationSince(startedAt), action: "modrinth_search", status: "failed", ...errorLogFields(error) }, "Modrinth search failed");
    throw error;
  }
});

app.post<{ Body: { serverId?: string; filename?: string; channel?: ReleaseChannel } }>("/api/modrinth/update", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.update");
  const server = await getServer(request.body.serverId);
  requireManagedModsRuntime(server);
  const { singular: contentName, Singular } = managedContentRuntime(server);
  return withTrackedModMutation(server, () => recordOperation({
    type: "mod.update",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: `Updating ${contentName}`,
    successTask: `${Singular} updated`
  }, () => updateModrinthMod(server, request.body)));
});

app.post<{ Body: { serverId?: string; filename?: string; versionId?: string; channel?: ReleaseChannel; forceIncompatible?: boolean; overrideMinecraftVersion?: boolean } }>("/api/modrinth/switch-version", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.update");
  const server = await getServer(request.body.serverId);
  requireManagedModsRuntime(server);
  const { singular: contentName, Singular } = managedContentRuntime(server);
  return withTrackedModMutation(server, () => recordOperation({
    type: "mod.update",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: `Switching ${contentName} version`,
    successTask: `${Singular} version switched`
  }, () => switchModrinthModVersion(server, request.body)));
});

app.post<{ Body: { serverId?: string; filename?: string } }>("/api/modrinth/acknowledge-review", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.update");
  const server = await getServer(request.body.serverId);
  requireManagedModsRuntime(server);
  const { singular: contentName, Singular } = managedContentRuntime(server);
  return withModMutationLock(server.id, () => recordOperation({
    type: "mod.update",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: `Acknowledging ${contentName} review`,
    successTask: `${Singular} review acknowledged`
  }, () => acknowledgeInstalledModReview(server, request.body)));
});

app.post<{ Body: { serverId?: string; filenames?: string[]; channel?: ReleaseChannel } }>("/api/modrinth/update-safe", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.update");
  const server = await getServer(request.body.serverId);
  requireManagedModsRuntime(server);
  const { Singular, plural: contentPlural } = managedContentRuntime(server);
  return withTrackedModMutation(server, () => recordOperation({
    type: "mod.batchUpdate",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: `Updating ${contentPlural}`,
    successTask: `${Singular} update batch complete`
  }, async () => {
    const channel = optionalReleaseChannel(request.body.channel);
    const filenames = request.body.filenames === undefined
      ? undefined
      : asArray(request.body.filenames, "filenames").map((filename) => safeInstalledModFilename(requiredString(filename, "filename")));
    if (filenames && filenames.length > 100) throw new Error(`A safe update batch is limited to 100 ${managedContentRuntime(server).plural}`);
    const startedAt = Date.now();
    const plan = await buildModUpdatePlan(server, { forceRefresh: true, channel });
    const result = await executeSafeUpdatePlan(plan, filenames, (entry) => updateModrinthMod(server, { filename: entry.filename, channel }));
    for (const skipped of result.skipped) {
      logInfo({ ...serverLogFields(server), filename: skipped.filename, reason: skipped.reason, action: "update_mod_safe_batch_item", status: "skipped" }, "Safe batch mod update skipped item");
    }
    logInfo({
      ...serverLogFields(server),
      action: "update_mod_safe_batch",
      status: result.failed.length ? "partial" : "succeeded",
      updatedCount: result.counts.updated,
      skippedCount: result.counts.skipped,
      failedCount: result.counts.failed,
      durationMs: durationSince(startedAt)
    }, "Safe batch mod update completed");
    return result;
  }));
});
}
