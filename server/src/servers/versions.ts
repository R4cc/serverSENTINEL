import { readFile, stat, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { serverRuntimeDefinition } from "@serversentinel/contracts";

import { ensureWritableInsideServer, validateExistingInsideServer } from "../core.js";
import { dockerControlConfigured, dockerRecentLogs, readLatestServerLog } from "../runtime/local/dockerContainers.js";
import { parseServerProperties } from "../runtime/serverProperties.js";
import { runtimeTarget } from "../runtime/profile.js";
import { managedContentNaming } from "../modrinth/installPolicy.js";
import type { ManagedServer, ResolvedServerVersions, ServerRuntimeType } from "../types.js";
export const versionMetadataFilename = ".serversentinel-version.json";

export type VersionMetadata = {
  minecraftVersion?: string;
  runtimeType?: ServerRuntimeType;
  runtimeVersion?: string;
  createdAt?: string;
  updatedAt?: string;
};

export function versionResolution(version: string | undefined, source: ResolvedServerVersions["minecraftVersion"]["source"], lastCheckedAt: string) {
  return { version: version || undefined, source: version ? source : "unknown", lastCheckedAt };
}

export function compareVersionStrings(left?: string, right?: string) {
  if (!left || !right) return null;
  const parse = (value: string) => {
    const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return left === right ? 0 : null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export async function writeVersionMetadataFile(server: ManagedServer) {
  const now = new Date().toISOString();
  const targetRuntime = runtimeTarget(server);
  const metadata: VersionMetadata = {
    minecraftVersion: targetRuntime.minecraftVersion,
    runtimeType: targetRuntime.runtimeType,
    runtimeVersion: targetRuntime.runtimeVersion,
    createdAt: now,
    updatedAt: now
  };
  const target = await ensureWritableInsideServer(server, versionMetadataFilename);
  await writeFile(target, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

/**
 * A managed workload can rewrite its own launcher JAR, and `/api/app` reads it synchronously on a
 * servers.view request. The 16 MiB file cap does not bound the *expanded* size, so a DEFLATE bomb would
 * allocate gigabytes on the event loop. install.properties is a few hundred bytes of text in practice.
 */
export const launcherJarEntryMaxBytes = 1024 * 1024;

export function readZipEntry(buffer: Buffer, entryName: string) {
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) return undefined;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    if (name === entryName) {
      const data = buffer.subarray(dataStart, dataEnd);
      if (compressionMethod === 0) return data.byteLength > launcherJarEntryMaxBytes ? undefined : data;
      if (compressionMethod === 8) return inflateRawSync(data, { maxOutputLength: launcherJarEntryMaxBytes });
      return undefined;
    }
    offset = dataEnd;
  }
  return undefined;
}

export async function detectVersionsFromLauncherJar(server: ManagedServer): Promise<VersionMetadata> {
  const targetRuntime = runtimeTarget(server);
  if (targetRuntime.runtimeType !== "fabric") return {};
  try {
    const jarPath = await validateExistingInsideServer(server, runtimeTarget(server).serverJar);
    const jarStat = await stat(jarPath);
    if (!jarStat.isFile() || jarStat.size > 16 * 1024 * 1024) return {};
    const installProperties = readZipEntry(await readFile(jarPath), "install.properties");
    if (!installProperties) return {};
    const values = parseServerProperties(installProperties.toString("utf8"));
    return {
      minecraftVersion: values["game-version"],
      runtimeType: "fabric",
      runtimeVersion: values["fabric-loader-version"]
    };
  } catch {
    return {};
  }
}

export function detectVersionsFromLogText(logText: string, runtimeType: ServerRuntimeType = "fabric"): VersionMetadata {
  const minecraftMatches = [...logText.matchAll(/Starting minecraft server version\s+([^\s]+)/gi)];
  const runtimeVersion = runtimeType === "fabric"
    ? [
        ...logText.matchAll(/Loading Fabric Loader\s+([^\s]+)/gi),
        ...logText.matchAll(/Fabric Loader[^0-9]*(\d+(?:\.\d+)+(?:[-+][\w.-]+)?)/gi)
      ].at(-1)?.[1]
    : detectedPaperBuild(logText);
  return {
    minecraftVersion: minecraftMatches.at(-1)?.[1],
    runtimeType,
    runtimeVersion
  };
}

export function detectedPaperBuild(logText: string) {
  const token = [...logText.matchAll(/(?:This server is running|Starting) Paper version\s+([^\s]+)/gi)].at(-1)?.[1];
  if (!token) return undefined;
  if (/^\d+$/.test(token)) return token;
  return token.match(/^(?:git-)?paper-(\d+)/i)?.[1]
    ?? token.match(/^\d+(?:\.\d+){1,2}-(\d+)/)?.[1]
    ?? token;
}

export function supportsManagedMods(server: Pick<ManagedServer, "runtimeProfile">) {
  const runtime = serverRuntimeDefinition(runtimeTarget(server).runtimeType);
  return runtime.managedContent;
}

export function requireManagedModsRuntime(server: Pick<ManagedServer, "runtimeProfile">) {
  if (supportsManagedMods(server)) return;
  const runtime = serverRuntimeDefinition(runtimeTarget(server).runtimeType);
  throw new Error(`${runtime.displayName} does not advertise managed ${runtime.contentKind}.`);
}

export function managedContentRuntime(server: Pick<ManagedServer, "runtimeProfile">) {
  requireManagedModsRuntime(server);
  const target = runtimeTarget(server);
  return {
    target,
    definition: serverRuntimeDefinition(target.runtimeType),
    ...managedContentNaming(target.runtimeType)
  };
}

export async function detectVersionsFromLogs(server: ManagedServer) {
  const logs = await Promise.allSettled([
    readLatestServerLog(server),
    dockerControlConfigured(server) ? dockerRecentLogs(server) : Promise.resolve("")
  ]);
  const text = logs
    .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
    .map((result) => result.value)
    .join("\n");
  return detectVersionsFromLogText(text, runtimeTarget(server).runtimeType);
}

export async function resolveServerVersions(server: ManagedServer): Promise<ResolvedServerVersions> {
  const lastCheckedAt = new Date().toISOString();
  const targetRuntime = runtimeTarget(server);
  const detected = await detectVersionsFromLauncherJar(server);
  const logs = detected.minecraftVersion && detected.runtimeVersion
    ? {}
    : await detectVersionsFromLogs(server);

  const minecraftSource = detected.minecraftVersion ? "detected" : logs.minecraftVersion ? "log" : targetRuntime.minecraftVersion ? "profile" : "unknown";
  const runtimeSource = detected.runtimeVersion ? "detected" : logs.runtimeVersion ? "log" : targetRuntime.runtimeVersion ? "profile" : "unknown";
  const runtimeVersion = versionResolution(detected.runtimeVersion || logs.runtimeVersion || targetRuntime.runtimeVersion, runtimeSource, lastCheckedAt);
  return {
    minecraftVersion: versionResolution(detected.minecraftVersion || logs.minecraftVersion || targetRuntime.minecraftVersion, minecraftSource, lastCheckedAt),
    runtimeVersion
  };
}
