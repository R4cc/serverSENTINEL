import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ServerRuntimeProfile } from "../types.js";
import { assertRuntimeArtifactUrl, readRuntimeArtifact, verifyRuntimeArtifact } from "./artifact.js";

function profile(content: Buffer): ServerRuntimeProfile {
  return {
    minecraftVersion: "1.21.11",
    runtimeType: "paper",
    runtimeVersion: "132",
    javaMajorVersion: 21,
    jarProvider: "papermc",
    jarArtifact: {
      filename: "paper.jar",
      downloadUrl: "https://fill-data.papermc.io/v1/objects/hash/paper.jar",
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex")
    },
    compatibilityStatus: "compatible",
    resolvedAt: "2026-07-18T00:00:00.000Z"
  };
}

describe("runtime artifacts", () => {
  it("allows official PaperMC download hosts and verifies exact content", () => {
    const content = Buffer.from("paper server jar");
    const runtimeProfile = profile(content);

    expect(assertRuntimeArtifactUrl(runtimeProfile, "https://mcjars.test")).toBe("https://fill-data.papermc.io/v1/objects/hash/paper.jar");
    expect(() => verifyRuntimeArtifact(runtimeProfile, content)).not.toThrow();
  });

  it("rejects size and SHA-256 mismatches before the server jar is written", () => {
    const content = Buffer.from("paper server jar");
    const runtimeProfile = profile(content);

    expect(() => verifyRuntimeArtifact(runtimeProfile, Buffer.from("wrong"))).toThrow("size mismatch");
    expect(() => verifyRuntimeArtifact({
      ...runtimeProfile,
      jarArtifact: { ...runtimeProfile.jarArtifact, sizeBytes: undefined }
    }, Buffer.from("wrong"))).toThrow("SHA-256 verification");
  });

  it("enforces the size limit while streaming when content-length is unavailable", async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4, 5]));

    await expect(readRuntimeArtifact(response, 4)).rejects.toThrow("exceeds 0 MiB");
  });
});
