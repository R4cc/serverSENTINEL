import { createHash } from "node:crypto";
import type { ServerRuntimeProfile } from "../types.js";
import { assertMcJarsArtifactUrl, assertPaperMcArtifactUrl } from "../http/outboundUrls.js";

export const maxRuntimeArtifactBytes = 512 * 1024 * 1024;

export function assertRuntimeArtifactUrl(profile: ServerRuntimeProfile, mcjarsBaseUrl: string) {
  const downloadUrl = profile.jarArtifact.downloadUrl;
  if (!downloadUrl) throw new Error("Runtime artifact download URL is required");
  return profile.jarProvider === "papermc"
    ? assertPaperMcArtifactUrl(downloadUrl)
    : assertMcJarsArtifactUrl(downloadUrl, mcjarsBaseUrl);
}

export function verifyRuntimeArtifact(profile: ServerRuntimeProfile, content: Buffer) {
  const artifact = profile.jarArtifact;
  if (content.length === 0) throw new Error("Downloaded runtime artifact is empty");
  if (content.length > maxRuntimeArtifactBytes) {
    throw new Error(`Downloaded runtime artifact exceeds ${Math.floor(maxRuntimeArtifactBytes / 1024 / 1024)} MiB`);
  }
  if (artifact.sizeBytes !== undefined && content.length !== artifact.sizeBytes) {
    throw new Error(`Downloaded runtime artifact size mismatch: expected ${artifact.sizeBytes} bytes, received ${content.length}`);
  }
  if (artifact.sha256) {
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual.toLowerCase() !== artifact.sha256.toLowerCase()) {
      throw new Error("Downloaded runtime artifact failed SHA-256 verification");
    }
  }
  if (artifact.sha1) {
    const actual = createHash("sha1").update(content).digest("hex");
    if (actual.toLowerCase() !== artifact.sha1.toLowerCase()) {
      throw new Error("Downloaded runtime artifact failed SHA-1 verification");
    }
  }
}

type RuntimeArtifactReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
};

type RuntimeArtifactResponse = {
  body: { getReader(): RuntimeArtifactReader } | null;
};

export async function readRuntimeArtifact(response: RuntimeArtifactResponse, maximumBytes = maxRuntimeArtifactBytes) {
  if (!response.body) throw new Error("Runtime artifact download returned no body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Downloaded runtime artifact exceeds ${Math.floor(maximumBytes / 1024 / 1024)} MiB`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}
