import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { managedContentFileSizeLimit } from "../managedContentLimits.js";
import { assertDownloadableModrinthFile, assertModrinthDownloadSize } from "./installPolicy.js";
import { modrinthFetch } from "./modrinthClient.js";

type JarFile = { url: string; size?: number; hashes?: Record<string, string> };

/** Validates once, during transfer. Consumers must reach EOF before publishing the staged file. */
export async function downloadModrinthJarStream(file: JarFile, options: {
  singular?: "mod" | "plugin"; maximumBytes?: number; signal?: AbortSignal;
} = {}) {
  const limits = { singular: options.singular ?? "mod", maximumBytes: options.maximumBytes ?? managedContentFileSizeLimit };
  assertDownloadableModrinthFile(file, limits);
  const response = await modrinthFetch(file.url, { signal: options.signal });
  try {
    if (!response.ok) throw new Error(`Modrinth JAR download failed: ${response.statusText}`);
    assertModrinthDownloadSize(Number(response.headers.get("content-length")), limits);
    if (!response.body) throw new Error("Modrinth JAR download returned no body");
    const hashes = ["sha1", "sha512"].filter((algorithm) => file.hashes?.[algorithm])
      .map((algorithm) => ({ algorithm, hash: createHash(algorithm) }));
    const source = Readable.fromWeb(response.body as never);
    const stream = Readable.from((async function* () {
      let bytes = 0;
      let header = Buffer.alloc(0);
      try {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > limits.maximumBytes) throw new Error(`Downloaded ${limits.singular} is larger than ${Math.floor(limits.maximumBytes / 1024 / 1024)} MiB`);
          for (const { hash } of hashes) hash.update(chunk);
          if (header.length < 4) header = Buffer.concat([header, chunk.subarray(0, 4 - header.length)]);
          yield chunk;
        }
        options.signal?.throwIfAborted();
        if (header.length < 4 || header[0] !== 0x50 || header[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(header[2])) {
          throw new Error(`Downloaded ${limits.singular} must be a valid .jar file`);
        }
        for (const { algorithm, hash } of hashes) {
          if (hash.digest("hex") !== file.hashes![algorithm]) throw new Error("Downloaded JAR hash did not match Modrinth metadata");
        }
      } finally { source.destroy(); }
    })(), { objectMode: false });
    stream.on("close", () => source.destroy());
    return stream;
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
}
