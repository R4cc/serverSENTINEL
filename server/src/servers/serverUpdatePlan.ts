import { maxServerPort, minServerPort } from "../config.js";
import { optionalStrictBoolean, validateDockerContainerName, validateDockerImageName, validateJavaArgs } from "../http/validation.js";
import { defaultDockerImageForMinecraftVersion, runtimeProfileForServer } from "../runtime/profile.js";
import { runtimeSelection, runtimeUpdatePlan } from "../runtime/selection.js";
import { defaultServerContainerName } from "../storage/serverIdentity.js";
import { isValidServerPort } from "./ports.js";
import type { ManagedServer, ServerRuntimeProfile } from "../types.js";

/**
 * The part of "update a server" that is identical for a locally managed server and one owned by a
 * remote node: resolving the runtime profile and normalizing the container fields.
 *
 * Port allocation and persistence deliberately stay with the callers — the panel can see every
 * server and so reserves ports globally, while a node agent only knows about its own.
 */

export type ServerUpdateInput = {
  displayName?: string;
  runtime?: unknown;
  dockerContainer?: string;
  dockerImage?: string;
  dockerPorts?: string;
  queryPort?: string;
  javaArgs?: string;
  serverPort?: string;
  startOnNodeStart?: boolean;
};

export type ServerUpdatePlan = {
  runtimeProfile: ServerRuntimeProfile;
  displayName: string;
  dockerContainer: string;
  dockerImage: string;
  javaArgs: string;
  serverPort: string;
  requestedDockerPorts: string | undefined;
  startOnNodeStart: boolean;
  /** The jar must be re-downloaded. */
  jarChanged: boolean;
  /**
   * Whether the container must be recreated. Takes the caller's final port string, because the query
   * port is folded in differently on each side and the comparison must see the value actually stored.
   */
  containerConfigChanged: (finalDockerPorts: string | undefined) => boolean;
};

export async function planServerUpdate(
  current: ManagedServer,
  input: ServerUpdateInput,
  options: {
    resolveServerJar: (request: {
      runtimeType: ServerRuntimeProfile["runtimeType"];
      minecraftVersion: string;
      runtimeVersion?: string;
      preferStable: boolean;
    }) => Promise<ServerRuntimeProfile | null | undefined>;
    /** Differs per caller: the panel points at its runtime provider, a node at its own. */
    provisioningUnavailableMessage: (runtimeDisplayName: string) => string;
  }
): Promise<ServerUpdatePlan> {
  const currentRuntime = runtimeProfileForServer(current);
  const selectedRuntime = input.runtime === undefined ? undefined : runtimeSelection(input.runtime);
  const { runtimeType, runtimeDefinition, minecraftVersion, requestedRuntimeVersion, serverJar, shouldResolveRuntime } =
    runtimeUpdatePlan(currentRuntime, selectedRuntime);

  if (shouldResolveRuntime && !runtimeDefinition.managedProvisioning) {
    throw new Error(options.provisioningUnavailableMessage(runtimeDefinition.displayName));
  }
  const resolvedRuntime = shouldResolveRuntime
    ? await options.resolveServerJar({
        runtimeType,
        minecraftVersion,
        runtimeVersion: requestedRuntimeVersion,
        preferStable: true
      })
    : currentRuntime;
  if (!resolvedRuntime) {
    throw new Error("A runtime profile is required before changing server settings");
  }
  const runtimeProfile: ServerRuntimeProfile = {
    ...resolvedRuntime,
    jarArtifact: {
      ...resolvedRuntime.jarArtifact,
      filename: serverJar
    }
  };

  const serverPort = input.serverPort?.trim() ?? "";
  if (serverPort && !isValidServerPort(serverPort)) {
    throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
  }
  const dockerContainer = validateDockerContainerName(
    input.dockerContainer?.trim() || current.dockerContainer || defaultServerContainerName(current.id)
  );
  const dockerImage = validateDockerImageName(
    input.dockerImage?.trim() || current.dockerImage || defaultDockerImageForMinecraftVersion(runtimeProfile.minecraftVersion)
  );
  const requestedDockerPorts = input.dockerPorts?.trim() || (serverPort ? `${serverPort}:${serverPort}/tcp` : current.dockerPorts);
  const javaArgs = validateJavaArgs(input.javaArgs?.trim() || current.javaArgs || "-Xms2G -Xmx4G");
  const startOnNodeStart = optionalStrictBoolean(input.startOnNodeStart, "startOnNodeStart", current.startOnNodeStart ?? false);

  const jarChanged = currentRuntime.minecraftVersion !== minecraftVersion
    || currentRuntime.runtimeType !== runtimeProfile.runtimeType
    || currentRuntime.runtimeVersion !== runtimeProfile.runtimeVersion
    || currentRuntime.jarArtifact.filename !== serverJar
    || current.runtimeProfile.jarArtifact.downloadUrl !== runtimeProfile.jarArtifact.downloadUrl;
  const containerConfigChanged = (finalDockerPorts: string | undefined) =>
    current.dockerContainer !== dockerContainer
    || current.dockerImage !== dockerImage
    || current.dockerPorts !== finalDockerPorts
    || current.javaArgs !== javaArgs
    || currentRuntime.jarArtifact.filename !== serverJar;

  return {
    runtimeProfile,
    displayName: input.displayName?.trim() || current.displayName,
    dockerContainer,
    dockerImage,
    javaArgs,
    serverPort,
    requestedDockerPorts,
    startOnNodeStart,
    jarChanged,
    containerConfigChanged
  };
}
