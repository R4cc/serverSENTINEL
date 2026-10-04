import { Readable, Transform } from "node:stream";
import { managedContentFileSizeLimit } from "../managedContentLimits.js";
import { operationInProgress } from "../http/errors.js";
import { badRequest } from "../http/validation.js";
import type { NodeRuntime, RuntimeUploadSource } from "../nodes/types.js";
import type { ManagedServer } from "../types.js";
import { services } from "../appServices.js";
import { serverMutations } from "../servers/mutationCoordinator.js";
export const activeModMutations = new Set<string>();
export const modFileSizeLimit = managedContentFileSizeLimit;

export async function withModMutationLock<T>(serverId: string, operation: () => Promise<T>) {
  return serverMutations.run(serverId, () => services.exportCoordinator.withMutation(serverId, async () => {
    if (activeModMutations.has(serverId)) operationInProgress("Another mod change is already running for this server", "MOD_OPERATION_IN_PROGRESS");
    activeModMutations.add(serverId);
    try {
      return await operation();
    } finally {
      activeModMutations.delete(serverId);
    }
  }));
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

