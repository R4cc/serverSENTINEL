import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dockerBufferBodyRequest, dockerJsonRequest, dockerRequest } from "../docker/dockerClient.js";
import { parseDockerPorts } from "../core.js";
import { isManagedContainerFor } from "../runtime/containerLabels.js";
import { inspectDockerContainer } from "../runtime/local/dockerContainers.js";
import type { ManagedServer } from "../types.js";

export type PlayerTcpConnection = {
  remoteAddress: string;
  remotePort: number;
  rttUs: number;
};

export type PlayerConnectionObservation =
  | { status: "idle"; instanceId?: string; connections: [] }
  | { status: "available"; instanceId: string; connections: PlayerTcpConnection[] }
  | { status: "unsupported" | "unavailable"; instanceId?: string; connections: [] };

const probeContainerPath = "/tmp/.serversentinel-tcp-rtt";
const probeHostPath = fileURLToPath(new URL("../../native/tcp-rtt-probe", import.meta.url));
const probeOutputMaxBytes = 256 * 1024;

type DockerExecCreated = { Id?: string };
type DockerExecInspect = { Running?: boolean; ExitCode?: number };

function writeTarText(target: Buffer, offset: number, length: number, value: string) {
  target.fill(0, offset, offset + length);
  target.write(value, offset, Math.min(length, Buffer.byteLength(value)), "ascii");
}

function writeTarOctal(target: Buffer, offset: number, length: number, value: number) {
  writeTarText(target, offset, length, `${Math.max(0, value).toString(8).padStart(length - 1, "0")}\0`);
}

/** A one-member ustar archive accepted by Docker's copy-to-container endpoint. */
export function executableTarArchive(name: string, content: Buffer) {
  if (!name || name.includes("/") || Buffer.byteLength(name) > 100) throw new Error("Probe archive name is invalid");
  const paddedSize = Math.ceil(content.length / 512) * 512;
  const archive = Buffer.alloc(512 + paddedSize + 1024);
  writeTarText(archive, 0, 100, name);
  writeTarOctal(archive, 100, 8, 0o755);
  writeTarOctal(archive, 108, 8, 0);
  writeTarOctal(archive, 116, 8, 0);
  writeTarOctal(archive, 124, 12, content.length);
  writeTarOctal(archive, 136, 12, Math.floor(Date.now() / 1000));
  archive.fill(0x20, 148, 156);
  archive[156] = 0x30;
  writeTarText(archive, 257, 6, "ustar\0");
  writeTarText(archive, 263, 2, "00");
  const checksum = archive.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  writeTarText(archive, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  content.copy(archive, 512);
  return archive;
}

/** Decode Docker's non-TTY stdout/stderr frame format without ever merging stderr into JSON. */
export function dockerExecStdout(payload: Buffer) {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < payload.length) {
    if (payload.length - offset < 8) throw new Error("Docker exec returned a truncated stream frame");
    const stream = payload[offset];
    const length = payload.readUInt32BE(offset + 4);
    offset += 8;
    if (length > payload.length - offset) throw new Error("Docker exec returned a truncated stream payload");
    if (stream === 1) chunks.push(payload.subarray(offset, offset + length));
    else if (stream !== 2) throw new Error("Docker exec returned an unknown stream type");
    offset += length;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function internalMinecraftPort(server: ManagedServer) {
  const managed = server.managedPorts?.find((entry) => entry.type === "minecraft" && entry.protocol === "tcp")?.internalPort;
  if (managed && managed >= 1 && managed <= 65_535) return managed;
  const exposed = Object.keys(parseDockerPorts(server.dockerPorts || "25565:25565/tcp").exposedPorts)
    .map((entry) => entry.split("/"))
    .find(([, protocol]) => protocol === "tcp");
  const parsed = Number(exposed?.[0]);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : 25_565;
}

async function installProbe(containerId: string) {
  const binary = await readFile(probeHostPath);
  const archive = executableTarArchive(probeContainerPath.slice("/tmp/".length), binary);
  await dockerBufferBodyRequest(
    "PUT",
    `/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent("/tmp")}`,
    archive,
    200,
    { contentType: "application/x-tar", timeoutMs: 5_000, maxBytes: 16 * 1024 }
  );
}

async function executeProbe(containerId: string, port: number) {
  const created = await dockerJsonRequest<DockerExecCreated>("POST", `/containers/${encodeURIComponent(containerId)}/exec`, {
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Cmd: [probeContainerPath, "--port", String(port)]
  }, 201);
  if (!created.Id) throw new Error("Docker did not create the TCP RTT probe process");
  const output = await dockerBufferBodyRequest(
    "POST",
    `/exec/${encodeURIComponent(created.Id)}/start`,
    JSON.stringify({ Detach: false, Tty: false }),
    200,
    { contentType: "application/json", timeoutMs: 5_000, maxBytes: probeOutputMaxBytes }
  );
  const inspected = await dockerRequest<DockerExecInspect>("GET", `/exec/${encodeURIComponent(created.Id)}/json`, 200, undefined, 2_000);
  if (inspected.Running || inspected.ExitCode !== 0) throw new Error("The TCP RTT probe could not read this container's connections");
  return dockerExecStdout(output);
}

function normalizedProbeOutput(value: string): PlayerTcpConnection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The TCP RTT probe returned malformed output");
  }
  const connections = (parsed as { connections?: unknown })?.connections;
  if (!Array.isArray(connections) || connections.length > 4096) throw new Error("The TCP RTT probe returned an invalid connection list");
  return connections.map((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    if (typeof record.remoteAddress !== "string" || record.remoteAddress.length > 64
      || !Number.isInteger(record.remotePort) || (record.remotePort as number) < 1 || (record.remotePort as number) > 65_535
      || !Number.isFinite(record.rttUs) || (record.rttUs as number) <= 0 || (record.rttUs as number) > 60_000_000) {
      throw new Error("The TCP RTT probe returned an invalid connection");
    }
    return {
      remoteAddress: record.remoteAddress,
      remotePort: record.remotePort as number,
      rttUs: Math.round(record.rttUs as number)
    };
  });
}

export async function readDockerPlayerConnections(server: ManagedServer): Promise<PlayerConnectionObservation> {
  if (platform() !== "linux") {
    return { status: "unsupported", connections: [] };
  }
  const details = await inspectDockerContainer(server);
  if (!details?.State?.Running || !details.Id) {
    return { status: "idle", instanceId: details?.Id, connections: [] };
  }
  if (!isManagedContainerFor(details.Config?.Labels, server.id)) {
    return { status: "unavailable", instanceId: details.Id, connections: [] };
  }
  try {
    let output: string;
    try {
      output = await executeProbe(details.Id, internalMinecraftPort(server));
    } catch {
      await installProbe(details.Id);
      output = await executeProbe(details.Id, internalMinecraftPort(server));
    }
    return { status: "available", instanceId: details.Id, connections: normalizedProbeOutput(output) };
  } catch {
    return {
      status: "unavailable",
      instanceId: details.Id,
      connections: []
    };
  }
}
