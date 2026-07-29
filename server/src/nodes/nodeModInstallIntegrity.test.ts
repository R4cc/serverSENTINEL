import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedServer } from "../types.js";

/**
 * The node agent's direct Modrinth installer downloaded bytes and wrote them as managed executable
 * content without ever comparing the hashes Modrinth published, while the panel-side installer did.
 * These cover the wiring: a helper that exists but is not called is the original defect.
 */

const jar = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("fabric-api", "utf8")]);
const substituted = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("malicious", "utf8")]);
const publishedSha1 = createHash("sha1").update(jar).digest("hex");
const publishedSha512 = createHash("sha512").update(jar).digest("hex");

let tempRoot: string;
let servedBytes: Buffer;

function modrinthFile() {
  return {
    url: "https://cdn.modrinth.com/data/fabric-api/versions/1/fabric-api.jar",
    filename: "fabric-api.jar",
    primary: true,
    size: jar.byteLength,
    hashes: { sha1: publishedSha1, sha512: publishedSha512 }
  };
}

async function loadHooks() {
  vi.resetModules();
  process.env.SERVERSENTINEL_DATA_DIR = tempRoot;
  vi.doMock("../docker/dockerClient.js", () => ({
    dockerAvailable: () => false,
    dockerBufferRequest: vi.fn(),
    dockerErrorMessage: (body: string) => body,
    dockerJsonRequest: vi.fn(),
    dockerLogTailMaxBytes: 16 * 1024 * 1024,
    dockerRequest: vi.fn(),
    isMissingDockerNetworkError: () => false,
    sendDockerContainerStdinLine: vi.fn()
  }));
  vi.doMock("../modrinth/modrinthClient.js", () => ({
    modrinthFetch: async () => ({
      ok: true,
      statusText: "OK",
      arrayBuffer: async () => servedBytes.buffer.slice(servedBytes.byteOffset, servedBytes.byteOffset + servedBytes.byteLength)
    })
  }));
  vi.doMock("../modrinth/compatibility.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../modrinth/compatibility.js")>();
    return {
      ...actual,
      resolveModrinthProjectCompatibility: async () => ({
        status: "compatible",
        compatible: true,
        reason: "Compatible",
        matchedVersionNumber: "1.0.0",
        file: modrinthFile()
      }),
      fetchProject: async () => ({ server_side: "required", client_side: "optional" }),
      fetchProjectVersions: async () => []
    };
  });
  return (await import("./nodeAgent.js")).__nodeAgentTestHooks;
}

function fabricServer(): ManagedServer {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    nodeId: "node-1",
    displayName: "Survival",
    serverDir: join(tempRoot, "servers", "survival"),
    storageName: "survival",
    runtimeProfile: {
      minecraftVersion: "1.21.1",
      runtimeType: "fabric",
      runtimeVersion: "0.16.0",
      javaMajorVersion: 21,
      jarProvider: "mcjars",
      jarArtifact: { filename: "server.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: "2026-01-01T00:00:00.000Z"
    },
    createdAt: "",
    updatedAt: ""
  };
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "serversentinel-node-install-"));
  await mkdir(join(tempRoot, "servers", "survival"), { recursive: true });
  servedBytes = jar;
});

afterEach(async () => {
  vi.resetModules();
  await rm(tempRoot, { recursive: true, force: true });
});

describe("node agent direct Modrinth install integrity", () => {
  it("installs a JAR whose bytes match the published hashes", async () => {
    const hooks = await loadHooks();
    const server = fabricServer();

    await hooks.handleCommand("mods.install", { server, projectId: "fabric-api" });

    expect(await readFile(join(server.serverDir, "mods", "fabric-api.jar"))).toEqual(jar);
  });

  it("refuses a substituted JAR and writes nothing", async () => {
    const hooks = await loadHooks();
    const server = fabricServer();
    servedBytes = substituted;

    await expect(hooks.handleCommand("mods.install", { server, projectId: "fabric-api" }))
      .rejects.toThrow("Downloaded JAR hash did not match Modrinth metadata");

    await expect(readFile(join(server.serverDir, "mods", "fabric-api.jar"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
