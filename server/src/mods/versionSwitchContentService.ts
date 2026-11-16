import { versionSwitchPlannedStatus, type VersionSwitchContentEntry, type VersionSwitchOutcome, type VersionSwitchPlan } from "@serversentinel/contracts";
import { runtimeForServer } from "../appServices.js";
import { fetchProjects, fetchVersions, latestCompatibleVersionFor, minecraftVersionsInclude, normalizeReleaseChannel } from "../modrinth/compatibility.js";
import { managedContentRuntime } from "../servers/versions.js";
import { modrinthIconProxyUrl } from "./icons.js";
import { installModWithRemoteVersionFallback, listModsWithPanelMetadata, modsFromListResult, remoteModMetadata, updateModrinthMod } from "./modService.js";
import { errorMessage, planVersionSwitchContent, versionSwitchBaseEntry, type VersionSwitchInstalledContent } from "./versionSwitchContent.js";
import type { ManagedServer, ReleaseChannel } from "../types.js";

/**
 * The managed-content half of a Minecraft version switch: reading what is installed, planning it
 * against Modrinth, and carrying the plan out. The runtime half lives in servers/versionSwitch.ts.
 */

export type ContentChannels = Map<string, ReleaseChannel>;

function installedContent(listed: unknown): VersionSwitchInstalledContent[] {
  return modsFromListResult(listed).flatMap((mod) => {
    if (typeof mod.filename !== "string") return [];
    const metadata = remoteModMetadata(mod.modrinth);
    return [{
      filename: mod.filename,
      enabled: mod.enabled !== false && !mod.filename.endsWith(".disabled"),
      iconUrl: typeof mod.iconUrl === "string" ? mod.iconUrl : undefined,
      channel: normalizeReleaseChannel(typeof mod.preferredChannel === "string" ? mod.preferredChannel : undefined),
      metadata: metadata ? {
        projectId: metadata.projectId,
        versionId: metadata.versionId,
        versionNumber: metadata.versionNumber,
        gameVersions: metadata.gameVersions,
        loaders: metadata.loaders
      } : undefined
    }];
  });
}

/** Plans installed content for `minecraftVersion`, and records each jar's release channel for the apply. */
export async function planInstalledContent(server: ManagedServer, minecraftVersion: string): Promise<{ content: VersionSwitchContentEntry[]; channels: ContentChannels }> {
  const naming = managedContentRuntime(server);
  const installed = installedContent(await listModsWithPanelMetadata(server));
  const channels: ContentChannels = new Map(installed.map((item) => [item.filename, item.channel]));
  if (minecraftVersion === naming.target.minecraftVersion) {
    // A loader or build change alone leaves the game version, and so every jar's fit, as it was.
    const content = installed.map((item): VersionSwitchContentEntry => ({
      ...versionSwitchBaseEntry(item),
      action: item.enabled ? "keep" : "unchanged",
      reason: "The Minecraft version does not change."
    }));
    return { content, channels };
  }
  const filter = { loaders: naming.loaders, runtimeName: naming.definition.displayName, contentKind: naming.singular, minecraftVersion };
  const content = await planVersionSwitchContent(installed, {
    ...filter,
    versionMatches: minecraftVersionsInclude,
    iconUrl: modrinthIconProxyUrl
  }, {
    latestForTarget: (projectId, channel) => latestCompatibleVersionFor(projectId, { ...filter, channel }),
    versions: (versionIds) => fetchVersions(versionIds),
    projects: (projectIds) => fetchProjects(projectIds)
  });
  return { content, channels };
}

/**
 * Carries a plan out on a server that already runs the target version. A jar whose update or
 * install fails is disabled so the server can still start; every jar gets an outcome.
 */
export async function applyContentPlan(server: ManagedServer, plan: VersionSwitchPlan, channels: ContentChannels) {
  const runtime = runtimeForServer(server);
  const outcomes = new Map<VersionSwitchContentEntry, VersionSwitchOutcome>();
  const outcome = (entry: VersionSwitchContentEntry, value: Omit<VersionSwitchOutcome, "filename" | "displayName" | "plannedAction">) => {
    outcomes.set(entry, { filename: entry.filename, displayName: entry.displayName, plannedAction: entry.action, ...value });
  };
  const failure = (error: unknown) => errorMessage(error, "The change failed");
  const disable = async (entry: VersionSwitchContentEntry, reason: string) => {
    try {
      const result = await runtime.toggleMod(server, entry.filename, false) as { filename?: unknown } | undefined;
      outcome(entry, { status: "disabled", finalFilename: typeof result?.filename === "string" ? result.filename : undefined, reason });
    } catch (error) {
      outcome(entry, { status: "failed", reason: `${reason} Disabling it also failed: ${failure(error)}` });
    }
  };
  const planned = (action: VersionSwitchContentEntry["action"]) => plan.content.filter((entry) => entry.action === action && !outcomes.has(entry));

  for (const entry of [...planned("keep"), ...planned("unchanged")]) {
    outcome(entry, { status: versionSwitchPlannedStatus[entry.action], version: entry.currentVersion, reason: entry.reason });
  }
  for (const entry of planned("disable")) await disable(entry, entry.reason);
  for (const entry of planned("install")) {
    try {
      await installModWithRemoteVersionFallback(server, { projectId: entry.projectId, versionId: entry.targetVersionId, channel: "release" });
      outcome(entry, { status: "installed", version: entry.targetVersion, finalFilename: entry.targetFilename, reason: entry.reason });
    } catch (error) {
      outcome(entry, { status: "failed", reason: `Could not install: ${failure(error)}` });
      // Whatever needed it cannot load without it.
      for (const dependent of plan.content) {
        if (outcomes.has(dependent) || !entry.requiredBy?.includes(dependent.displayName) || !dependent.enabled) continue;
        await disable(dependent, `Requires ${entry.displayName}, which could not be installed.`);
      }
    }
  }
  for (const entry of planned("update")) {
    try {
      const result = await updateModrinthMod(server, { filename: entry.filename, channel: channels.get(entry.filename) }) as { filename?: unknown; version?: unknown };
      outcome(entry, {
        status: "updated",
        finalFilename: typeof result.filename === "string" ? result.filename : undefined,
        version: typeof result.version === "string" ? result.version : entry.targetVersion,
        reason: entry.reason
      });
    } catch (error) {
      const reason = `Update failed: ${failure(error)}`;
      if (entry.enabled) await disable(entry, `${reason} Disabled so the server can start.`);
      else outcome(entry, { status: "failed", reason });
    }
  }
  return plan.content.map((entry) => outcomes.get(entry)!);
}
