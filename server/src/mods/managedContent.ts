import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { readFile, rm, stat } from "node:fs/promises";
import { managedContentFileSizeLimit } from "../managedContentLimits.js";
import { operationInProgress } from "../http/errors.js";
import { badRequest } from "../http/validation.js";
import type { NodeRuntime, RuntimeUploadSource } from "../nodes/types.js";
import type { ManagedServer } from "../types.js";
export const activeModMutations = new Set<string>();
export const modFileSizeLimit = managedContentFileSizeLimit;

export async function withModMutationLock<T>(serverId: string, operation: () => Promise<T>) {
  if (activeModMutations.has(serverId)) operationInProgress("Another mod change is already running for this server", "MOD_OPERATION_IN_PROGRESS");
  activeModMutations.add(serverId);
  try {
    return await operation();
  } finally {
    activeModMutations.delete(serverId);
  }
}

export function uploadManagedContentBuffer(
  runtime: Pick<NodeRuntime, "uploadMod">,
  server: ManagedServer,
  filename: string,
  content: Buffer
) {
  return runtime.uploadMod(server, filename, {
    stream: Readable.from([content]),
    size: content.byteLength
  } satisfies RuntimeUploadSource);
}

export function assertJarBuffer(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(buffer[2])) {
    badRequest("Uploaded mod must be a valid .jar file");
  }
}

export async function verifyDownloadedJar(destination: string, file: { size?: number; hashes?: Record<string, string> }) {
  const downloaded = await stat(destination);
  if (!downloaded.isFile() || downloaded.size === 0 || downloaded.size > modFileSizeLimit) {
    await rm(destination, { force: true }).catch(() => {});
    throw new Error(`Downloaded mod must be between 1 byte and ${Math.floor(modFileSizeLimit / 1024 / 1024)} MiB`);
  }
  const buffer = await readFile(destination);
  assertJarBuffer(buffer);
  const expectedSha1 = file.hashes?.sha1;
  if (expectedSha1) {
    const actualSha1 = createHash("sha1").update(buffer).digest("hex");
    if (actualSha1 !== expectedSha1) {
      await rm(destination, { force: true }).catch(() => {});
      throw new Error("Downloaded mod hash did not match Modrinth metadata");
    }
  }
}

export function sizeLimitTransform(maxBytes: number) {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new Error(`Downloaded mod is larger than ${Math.floor(maxBytes / 1024 / 1024)} MiB`));
        return;
      }
      callback(null, chunk);
    }
  });
}

