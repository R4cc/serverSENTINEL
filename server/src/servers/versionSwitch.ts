import {
  javaMajorVersionForMinecraft,
  serverRuntimeDefinition,
  versionSwitchContentCounts,
  versionSwitchDirection,
  versionSwitchOutcomeCounts,
  versionSwitchWorldWarning,
  type VersionSwitchPlan,
  type VersionSwitchResult
} from "@serversentinel/contracts";
import { services } from "../appServices.js";
import { hasPermission } from "../permissions.js";
import { asObject, optionalString } from "../storage/valueValidation.js";
import { errorLogFields, logInfo, logWarn } from "../logging.js";
import { withRecordedModMutation } from "../mods/modService.js";
import { applyContentPlan, planInstalledContent, type ContentChannels } from "../mods/versionSwitchContentService.js";
import { runtimeProfileForServer } from "../runtime/profile.js";
import { serverLogFields } from "../runtime/local/dockerContainers.js";
import { managedContentRuntime, supportsManagedMods } from "./versions.js";
import { recordOperation } from "./lifecycle.js";
import { serverJarProvider } from "./provisioning.js";
import { applyServerSettingsUpdate } from "./serverSettingsUpdate.js";
import { followedDockerImage } from "./serverUpdatePlan.js";
import type { ManagedServer, StoredUser } from "../types.js";

/**
 * Switching a server to another Minecraft version: the runtime jar (Fabric loader or Paper build),
 * the default Java image, and every installed mod or plugin move together. Mods with a version for
 * the target are updated, newly required dependencies are installed, and anything that cannot run
 * on the target is disabled — never deleted — so the server can still boot.
 */

const contentPermissions = ["mods.update", "mods.enableDisable", "mods.install"] as const;

export type VersionSwitchRequest = {
  minecraftVersion: string;
  runtimeVersion?: string;
};

export function parseVersionSwitchRequest(input: unknown): VersionSwitchRequest {
  const body = asObject(input ?? {}, "version switch request");
  const minecraftVersion = optionalString(body.minecraftVersion, "minecraftVersion")?.trim() ?? "";
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/.test(minecraftVersion)) throw new Error("Choose a valid Minecraft version");
  const runtimeVersion = optionalString(body.runtimeVersion, "runtimeVersion")?.trim() || undefined;
  if (runtimeVersion && !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(runtimeVersion)) throw new Error("Choose a valid runtime version");
  return { minecraftVersion, runtimeVersion };
}

function contentSkippedReason(server: ManagedServer, user: Pick<StoredUser, "permissions">) {
  if (!supportsManagedMods(server)) return undefined;
  const plural = serverRuntimeDefinition(runtimeProfileForServer(server).runtimeType).contentKind;
  if (!services.moduleRegistry.isServing("managedContent")) {
    return `The Mods & plugins module is switched off, so installed ${plural} are left as they are. Check them before starting the server.`;
  }
  if (!contentPermissions.every((permission) => hasPermission(user, permission))) {
    return `Your account cannot update, install, and disable ${plural}, so they are left as they are. Check them before starting the server.`;
  }
  return undefined;
}

export async function planMinecraftVersionSwitch(
  server: ManagedServer,
  request: VersionSwitchRequest,
  user: Pick<StoredUser, "permissions">
): Promise<VersionSwitchPlan> {
  return (await buildVersionSwitchPlan(server, request, user)).plan;
}

async function buildVersionSwitchPlan(
  server: ManagedServer,
  request: VersionSwitchRequest,
  user: Pick<StoredUser, "permissions">
): Promise<{ plan: VersionSwitchPlan; channels: ContentChannels }> {
  const profile = runtimeProfileForServer(server);
  const definition = serverRuntimeDefinition(profile.runtimeType);
  if (!definition.managedProvisioning) {
    throw new Error(`${definition.displayName} version changes are not available until its runtime provider is enabled`);
  }
  const resolved = await serverJarProvider.resolveServerJar({
    runtimeType: profile.runtimeType,
    minecraftVersion: request.minecraftVersion,
    runtimeVersion: request.runtimeVersion || "latest",
    preferStable: true
  });
  if (!resolved) throw new Error(`${definition.displayName} is not available for Minecraft ${request.minecraftVersion}`);
  const targetRuntimeVersion = resolved.runtimeVersion || request.runtimeVersion;
  if (request.minecraftVersion === profile.minecraftVersion && targetRuntimeVersion === profile.runtimeVersion) {
    throw new Error(`This server already runs Minecraft ${profile.minecraftVersion} with ${definition.displayName} ${profile.runtimeVersion ?? ""}`.trim());
  }

  const { image: targetImage, customized: customImage, previousDefaultImage } = followedDockerImage(server, request.minecraftVersion);
  const direction = versionSwitchDirection(profile.minecraftVersion, request.minecraftVersion);
  const worldWarning = versionSwitchWorldWarning(direction, profile.minecraftVersion, request.minecraftVersion);
  const warnings = worldWarning ? [worldWarning] : [];
  const currentJava = javaMajorVersionForMinecraft(profile.minecraftVersion);
  const targetJava = javaMajorVersionForMinecraft(request.minecraftVersion);
  if (customImage && targetJava && currentJava !== targetJava) {
    warnings.push(`The custom image ${server.dockerImage} is kept, but Minecraft ${request.minecraftVersion} needs Java ${targetJava}. Change the image in Settings if it does not provide it.`);
  }

  const skippedReason = contentSkippedReason(server, user);
  const { content, channels } = supportsManagedMods(server) && !skippedReason
    ? await planInstalledContent(server, request.minecraftVersion)
    : { content: [], channels: new Map() as ContentChannels };
  if (skippedReason) warnings.push(skippedReason);

  const plan: VersionSwitchPlan = {
    serverId: server.id,
    generatedAt: new Date().toISOString(),
    runtimeType: profile.runtimeType,
    current: { minecraftVersion: profile.minecraftVersion, runtimeVersion: profile.runtimeVersion, dockerImage: server.dockerImage || previousDefaultImage },
    target: { minecraftVersion: request.minecraftVersion, runtimeVersion: targetRuntimeVersion, dockerImage: targetImage },
    direction,
    contentKind: definition.contentKind,
    content,
    contentSkippedReason: skippedReason,
    counts: versionSwitchContentCounts(content),
    warnings
  };
  return { plan, channels };
}

export async function applyMinecraftVersionSwitch(
  server: ManagedServer,
  request: VersionSwitchRequest,
  user: StoredUser
): Promise<{ server: ManagedServer; result: VersionSwitchResult }> {
  const { plan, channels } = await buildVersionSwitchPlan(server, request, user);
  const updatedServer = await applyServerSettingsUpdate(server, {
    runtime: {
      runtimeType: plan.runtimeType,
      minecraftVersion: plan.target.minecraftVersion,
      runtimeVersion: plan.target.runtimeVersion
    }
  });
  logInfo({
    ...serverLogFields(updatedServer),
    action: "version_switch",
    fromMinecraftVersion: plan.current.minecraftVersion,
    toMinecraftVersion: plan.target.minecraftVersion,
    runtimeVersion: plan.target.runtimeVersion
  }, "Server Minecraft version switched");

  // Kept and unchanged jars need no lock or history entry; anything else is one recorded batch.
  const actionable = plan.content.some((entry) => entry.action === "update" || entry.action === "install" || entry.action === "disable");
  const { plural, Singular } = actionable ? managedContentRuntime(updatedServer) : { plural: "", Singular: "" };
  const outcomes = actionable
    ? await withRecordedModMutation(updatedServer, user, () => recordOperation({
      type: "mod.batchUpdate",
      serverId: updatedServer.id,
      nodeId: updatedServer.nodeId,
      createdBy: user.id,
      task: `Moving ${plural} to Minecraft ${plan.target.minecraftVersion}`,
      successTask: `${Singular} changes for Minecraft ${plan.target.minecraftVersion} complete`
    }, () => applyContentPlan(updatedServer, plan, channels)))
    : await applyContentPlan(updatedServer, plan, channels);

  // Cached update checks describe the previous game version; refresh them in the background.
  const coordinator = services.modUpdatePlanCoordinator;
  if (coordinator && plan.content.length) {
    void coordinator.refresh(updatedServer).catch((error) => {
      logWarn({ serverId: updatedServer.id, ...errorLogFields(error) }, "Could not refresh mod update checks after a version switch");
    });
  }
  return { server: updatedServer, result: { plan, outcomes, counts: versionSwitchOutcomeCounts(outcomes) } };
}
