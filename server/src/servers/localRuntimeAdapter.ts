const serverSideEffectsQueue = new AsyncQueue();
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { services } from "../appServices.js";
import { AsyncQueue, validateExistingInsideServer } from "../core.js";
import { durationSince, logInfo, logOperationFailure, logWarn } from "../logging.js";
import { optionalStrictBoolean } from "../http/validation.js";
import { ensureManagedServerDirectory, readServers } from "./store.js";
import { allocateQueryPort, assertUniqueDockerHostPorts, dockerPortsWithManagedEntries, findExistingServerPortConflict, findProvisionPortConflict, normalizeManagedPorts, portConflictMessage, queryPortEntry, type CreateServerInput } from "./ports.js";
import { dockerCommandInputCapability, dockerControlConfigured, dockerRecentLogs, dockerStatus, ensureDockerContainer, inspectDockerContainer, minecraftContainerNetworkingConfig, readLatestServerLog, removeManagedDockerContainer, sendDockerStdinCommand, serverLogFields, updateServerProperties } from "../runtime/local/dockerContainers.js";
import { dockerAvailable } from "../docker/dockerClient.js";
import { publicServerStatus } from "./publicViews.js";
import { streamDockerLogs, streamLatestServerLog, type Client } from "./overview.js";
import { basename, dirname } from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { copyServerFile, createServerFolder, deleteServerEntry, fileUploadSizeLimit, listServerDirectory, moveServerEntry, previewServerFile, publicZipExtractionPlan, readServerTextFile, renameServerEntry, resolveUploadTarget, writeRuntimeUpload, writeServerTextFile } from "../runtime/local/fileService.js";
import { assertDownloadSize, filePreviewSizeLimit, fileZipLimits, toPublicPath } from "../files/fileService.js";
import { createZipArchiveStream, type FileArchiveEntry } from "../downloadArchive.js";
import { extractZipArchive, planZipExtraction } from "../zipArchive.js";
import { deleteModIcon } from "../mods/icons.js";
import { downloadServerJar, serverJarProvider } from "./provisioning.js";
import { stoppedServerMutationMessage } from "./lifecycle.js";
import { runtimeTarget } from "../runtime/profile.js";
import { writeVersionMetadataFile } from "./versions.js";
import type { RuntimeUploadSource } from "../nodes/types.js";
import { planServerUpdate } from "./serverUpdatePlan.js";
import type { ManagedServer } from "../types.js";
export async function localUpdateServer(serverId: string, input: unknown) {
  const body = input as {
    displayName?: string;
    runtime?: CreateServerInput["runtime"];
    dockerContainer?: string;
    dockerImage?: string;
    dockerPorts?: string;
    queryPort?: string;
    javaArgs?: string;
    serverPort?: string;
    startOnNodeStart?: boolean;
  };
  let updatedServer: ManagedServer | null = null;
  await serverSideEffectsQueue.enqueue(async () => {
    const servers = await readServers();
    const index = servers.findIndex((candidate) => candidate.id === serverId);
    if (index === -1) {
      throw new Error("Server not found");
    }

    const current = servers[index];
    if (servers.some((server) => server.id !== current.id && server.displayName.toLowerCase() === (body.displayName?.trim() || current.displayName).toLowerCase())) {
      throw new Error("A managed server with this display name already exists");
    }
    const status = await dockerStatus(current);
    if (status.running) {
      throw new Error(stoppedServerMutationMessage);
    }
    const plan = await planServerUpdate(current, body, {
      resolveServerJar: (request) => serverJarProvider.resolveServerJar(request),
      provisioningUnavailableMessage: (displayName) => `${displayName} version changes are not available until its runtime provider is enabled`
    });
    const { runtimeProfile, dockerContainer, dockerImage, javaArgs, serverPort, requestedDockerPorts, startOnNodeStart } = plan;
    const currentQueryPort = current.managedPorts?.find((port) => port.type === "query")?.externalPort;
    const queryPortInput = body.queryPort?.trim() || (currentQueryPort ? String(currentQueryPort) : undefined);
    const queryPort = queryPortInput
      ? allocateQueryPort(servers, current.nodeId, requestedDockerPorts || "", queryPortInput, { ignoreServerId: current.id })
      : allocateQueryPort(servers, current.nodeId, requestedDockerPorts || "", undefined, { ignoreServerId: current.id });
    const managedPorts = normalizeManagedPorts(requestedDockerPorts || "", [queryPortEntry(queryPort)]);
    const dockerPorts = dockerPortsWithManagedEntries(requestedDockerPorts || "", managedPorts);
    if (dockerPorts) assertUniqueDockerHostPorts(dockerPorts);
    if (dockerPorts) {
      const existingConflict = findExistingServerPortConflict(servers, current.nodeId, dockerPorts, current.id);
      if (existingConflict) {
        throw new Error(portConflictMessage(existingConflict.port, existingConflict.ownerName));
      }
      const provisionConflict = findProvisionPortConflict(current.nodeId, dockerPorts);
      if (provisionConflict) {
        throw new Error(portConflictMessage(provisionConflict.port, provisionConflict.ownerName));
      }
    }
    const jarChanged = plan.jarChanged;
    const containerConfigChanged = plan.containerConfigChanged(dockerPorts);
    const updated: ManagedServer = {
      ...current,
      displayName: plan.displayName,
      runtimeProfile,
      dockerContainer,
      dockerImage,
      dockerPorts,
      managedPorts,
      javaArgs,
      startOnNodeStart,
      updatedAt: new Date().toISOString()
    };

    if (jarChanged) {
      await downloadServerJar(updated);
    }
    if (containerConfigChanged && dockerAvailable() && !status.running) {
      const networkingConfig = minecraftContainerNetworkingConfig(await inspectDockerContainer(current).catch(() => null));
      await removeManagedDockerContainer(current);
      await ensureDockerContainer(updated, networkingConfig);
    }
    await writeVersionMetadataFile(updated);
    if (serverPort || queryPort !== currentQueryPort) {
      await updateServerProperties(updated, {
        ...(serverPort ? { "server-port": serverPort } : {}),
        "enable-query": "true",
        "query.port": String(queryPort)
      });
    }

    services.serversRepository.replaceMetadata(updated);
    updatedServer = updated;
  });
  return updatedServer!;
}

export async function localDeleteServer(server: ManagedServer, input: unknown) {
  const body = input as { confirmName?: string; deleteFiles?: boolean };
  let deletedContainer = false;
  let deletedFiles = false;
  let serverFields: Record<string, unknown> = {};

  await serverSideEffectsQueue.enqueue(async () => {
    const servers = await readServers();
    const index = servers.findIndex((candidate) => candidate.id === server.id);
    if (index === -1) {
      throw new Error("Server not found");
    }

    const current = servers[index];
    serverFields = serverLogFields(current);
    const status = await dockerStatus(current);
    if (status.running) {
      throw new Error("Stop the server before deleting it");
    }
    if (body.confirmName !== current.displayName) {
      throw new Error(`Type "${current.displayName}" to confirm deletion`);
    }

    deletedContainer = dockerAvailable() ? await removeManagedDockerContainer(current) : false;
    const deleteFiles = optionalStrictBoolean(body.deleteFiles, "deleteFiles", false);
    if (deleteFiles) {
      const directory = ensureManagedServerDirectory(current);
      await rm(directory, { recursive: true, force: true });
      deletedFiles = true;
    }

    services.serversRepository.delete(current.id);
  });

  logInfo({ ...serverFields, deletedFiles, deletedContainer, action: "delete_server" }, "Managed server deleted");
  return { ok: true, deletedFiles, deletedContainer };
}

export async function localServerStatus(server: ManagedServer) {
  const latestLogPath = await validateExistingInsideServer(server, "logs/latest.log").catch(() => "");
  const docker = await dockerStatus(server);
  const commandInput = await dockerCommandInputCapability(server, docker);
  return publicServerStatus({
    server,
    docker,
    fileLogsAvailable: Boolean(latestLogPath && existsSync(latestLogPath)),
    controlAvailable: Boolean(docker.controllable),
    commandInputAvailable: commandInput.available,
    commandInputMessage: commandInput.message
  }, server);
}

export async function localSendConsoleCommand(server: ManagedServer, command: unknown) {
  const startedAt = Date.now();
  try {
    const result = await sendDockerStdinCommand(server, typeof command === "string" ? command : "");
    logInfo({ ...serverLogFields(server), action: "send_console_command", commandsCount: 1, durationMs: durationSince(startedAt), status: "succeeded" }, "Console command sent");
    return result;
  } catch (error) {
    logOperationFailure({ ...serverLogFields(server), action: "send_console_command", commandsCount: typeof command === "string" && command.trim() ? 1 : 0, durationMs: durationSince(startedAt), status: "failed" }, "Console command failed", error);
    throw error;
  }
}

export async function localStreamConsole(server: ManagedServer, client: unknown, onClose: (cleanup: () => void) => void) {
  const consoleClient = client as Client;
  consoleClient.send(JSON.stringify({ type: "status", status: await dockerStatus(server) }));
  if (dockerControlConfigured(server) && dockerAvailable()) {
    const logRequest = streamDockerLogs(server, consoleClient);
    onClose(() => logRequest?.destroy());
    return;
  }

  onClose(streamLatestServerLog(server, consoleClient));
}

export async function localServerLogs(server: ManagedServer, lineLimit?: number) {
  if (dockerControlConfigured(server) && dockerAvailable()) {
    return { text: await dockerRecentLogs(server, lineLimit), source: "docker" };
  }
  return { text: await readLatestServerLog(server, lineLimit), source: "logs/latest.log" };
}

export async function localListFiles(server: ManagedServer, target: string) {
  return listServerDirectory(server, target);
}

export async function localPreviewFile(server: ManagedServer, target: string) {
  return previewServerFile(server, target, { sizeLimit: filePreviewSizeLimit, requireTextLike: true });
}

export async function localDownloadFile(_server: ManagedServer, target: string) {
  const targetStat = await stat(target);
  if (!targetStat.isFile()) {
    throw new Error("Only files can be downloaded");
  }
  assertDownloadSize(targetStat.size);
  return {
    filename: basename(target),
    size: targetStat.size,
    stream: createReadStream(target)
  };
}

export async function localDownloadArchive(_server: ManagedServer, entries: FileArchiveEntry[], filename: string) {
  const size = entries.reduce((total, entry) => total + (entry.type === "file" ? entry.size : 0), 0);
  assertDownloadSize(size);
  return {
    filename,
    size,
    stream: createZipArchiveStream(entries)
  };
}

export async function localPlanArchiveExtraction(server: ManagedServer, archivePath: string, destinationPath: string) {
  return publicZipExtractionPlan(server, await planZipExtraction(archivePath, destinationPath, fileZipLimits));
}

export async function localExtractArchive(server: ManagedServer, archivePath: string, destinationPath: string, conflictPolicy: "replace" | "skip", report?: (progress: number, task: string) => void) {
  const result = await extractZipArchive({ archivePath, destinationPath, conflictPolicy, limits: fileZipLimits, report });
  return { ...result, destinationPath: toPublicPath(server, result.destinationPath) };
}

export async function localReadEditableFile(server: ManagedServer, target: string) {
  return readServerTextFile(server, target, {
    onRejected: (reason, path, size) => logWarn(
      { ...serverLogFields(server), path, ...(reason === "editor_size_limit" ? { size } : {}), reason },
      "File edit rejected"
    )
  });
}

export async function localWriteEditableFile(server: ManagedServer, target: string, content: unknown) {
  const result = await writeServerTextFile(server, target, content);
  logInfo({ ...serverLogFields(server), path: result.path, action: "write_file" }, "Server file written");
  return result;
}

export async function localCreateFolder(server: ManagedServer, parent: string, name: unknown) {
  const result = await createServerFolder(server, parent, name);
  logInfo({ ...serverLogFields(server), path: result.path, action: "create_folder" }, "Server folder created");
  return result;
}

export async function localUploadFile(server: ManagedServer, parent: string, filenameInput: unknown, content: RuntimeUploadSource) {
  const target = await resolveUploadTarget(server, parent, filenameInput);
  const size = await writeRuntimeUpload(target, content, {
    maximumBytes: fileUploadSizeLimit,
    allowEmpty: true,
    label: "Uploaded file content"
  });
  const path = toPublicPath(server, target);
  logInfo({ ...serverLogFields(server), path, size, action: "upload_file" }, "Server file uploaded");
  return { ok: true, path, size };
}

export async function localRenameFile(server: ManagedServer, source: string, name: unknown) {
  const result = await renameServerEntry(server, source, name);
  logInfo({ ...serverLogFields(server), fromPath: toPublicPath(server, source), path: result.path, action: "rename_file" }, "Server file renamed");
  return result;
}

export async function localMoveFile(server: ManagedServer, source: string, destinationParent: string) {
  const result = await moveServerEntry(server, source, destinationParent);
  logInfo({ ...serverLogFields(server), fromPath: toPublicPath(server, source), path: result.path, action: "move_file" }, "Server file moved");
  return result;
}

export async function localDuplicateFile(server: ManagedServer, source: string, name: unknown) {
  const result = await copyServerFile(server, source, dirname(source), name);
  logInfo({ ...serverLogFields(server), fromPath: toPublicPath(server, source), path: result.path, action: "duplicate_file" }, "Server file duplicated");
  return result;
}

export async function localDeleteFile(server: ManagedServer, target: string, recursive: unknown) {
  const result = await deleteServerEntry(server, target, recursive);
  const contentDirectory = serverRuntimeDefinition(runtimeTarget(server).runtimeType).contentDirectory;
  if (result.path.startsWith(`/${contentDirectory}/`) && (result.path.endsWith(".jar") || result.path.endsWith(".jar.disabled"))) {
    await deleteModIcon(server, basename(result.path));
  }
  logInfo({ ...serverLogFields(server), path: result.path, recursive: recursive === "true", action: "delete_file" }, "Server file deleted");
  return result;
}

