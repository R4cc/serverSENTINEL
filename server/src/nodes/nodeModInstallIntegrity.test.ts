import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
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
let servedResponse: (() => Response) | undefined;
let loadedHooks: typeof import("./nodeAgent.js").__nodeAgentTestHooks | undefined;

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
    dockerReachable: async () => false,
    dockerRequest: vi.fn(),
    isMissingDockerNetworkError: () => false,
    sendDockerContainerStdinLine: vi.fn()
  }));
  vi.doMock("../modrinth/modrinthClient.js", () => ({
    modrinthFetch: async () => servedResponse ? servedResponse() : new Response(new Uint8Array(servedBytes))
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
  loadedHooks = (await import("./nodeAgent.js")).__nodeAgentTestHooks;
  return loadedHooks;
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
  servedResponse = undefined;
});

afterEach(async () => {
  loadedHooks?.closeStorage();
  loadedHooks = undefined;
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

  it("cancels an oversized chunked body and removes the temporary download", async () => {
    const { managedContentFileSizeLimit } = await import("../managedContentLimits.js");
    const cancel = vi.fn();
    let chunks = 0;
    servedResponse = () => new Response(new ReadableStream<Uint8Array>({
      pull(stream) { chunks += 1; stream.enqueue(new Uint8Array(1024 * 1024)); }, cancel
    }));
    const hooks = await loadHooks();
    const server = fabricServer();
    await expect(hooks.handleCommand("mods.install", { server, projectId: "fabric-api" })).rejects.toThrow("larger than");
    expect(chunks).toBeLessThanOrEqual(managedContentFileSizeLimit / (1024 * 1024) + 4);
    expect(cancel).toHaveBeenCalled();
    expect(await readdir(join(server.serverDir, "mods"))).toEqual([]);
  });

  it("cleans up an interrupted streamed download without publishing it", async () => {
    let chunks = 0;
    servedResponse = () => new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        if (chunks++ === 0) stream.enqueue(new Uint8Array(jar));
        else stream.error(new Error("body stalled and timed out"));
      }
    }));
    const hooks = await loadHooks();
    const server = fabricServer();
    await expect(hooks.handleCommand("mods.install", { server, projectId: "fabric-api" })).rejects.toThrow("timed out");
    expect(await readdir(join(server.serverDir, "mods"))).toEqual([]);
  });

  it("verifies hashes incrementally across split JAR headers", async () => {
    servedResponse = () => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        for (const byte of jar) stream.enqueue(Uint8Array.of(byte));
        stream.close();
      }
    }));
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
