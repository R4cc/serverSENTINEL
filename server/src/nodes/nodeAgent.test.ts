import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedServer, ServerRuntimeProfile } from "../types.js";

type NodeAgentTestHooks = typeof import("./nodeAgent.js").__nodeAgentTestHooks;

let tempRoot: string;
let hooks: NodeAgentTestHooks;

function testRuntimeProfile(): ServerRuntimeProfile {
  return {
    minecraftVersion: "1.21.4",
    loader: "fabric",
    loaderVersion: "0.16.10",
    javaMajorVersion: 21,
    jarProvider: "mcjars",
    jarArtifact: {
      filename: "fabric-server-launch.jar",
      downloadUrl: "https://example.invalid/fabric-server-launch.jar"
    },
    compatibilityStatus: "compatible",
    resolvedAt: new Date().toISOString()
  };
}

function testServer(storageName = "survival"): ManagedServer {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    nodeId: "node-1",
    displayName: "Survival",
    serverDir: join(tempRoot, "servers", storageName),
    storageName,
    minecraftVersion: "1.21.4",
    loaderVersion: "0.16.10",
    serverJar: "fabric-server-launch.jar",
    runtimeProfile: testRuntimeProfile(),
    dockerContainer: "serversentinel-survival",
    dockerImage: "eclipse-temurin:21-jre",
    dockerPorts: "25565:25565/tcp,25566:25566/udp",
    javaArgs: "-Xms2G -Xmx4G",
    serverType: "fabric",
    createdAt: "",
    updatedAt: ""
  };
}

async function loadHooks() {
  vi.resetModules();
  process.env.SERVERSENTINEL_DATA_DIR = tempRoot;
  return (await import("./nodeAgent.js")).__nodeAgentTestHooks;
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "serversentinel-node-agent-"));
  hooks = await loadHooks();
});

afterEach(async () => {
  delete process.env.SERVERSENTINEL_DATA_DIR;
  vi.resetModules();
  await rm(tempRoot, { recursive: true, force: true });
});

describe("remote node create and Docker command safety", () => {
  it("creates immutable server identity independent of display name", () => {
    const { server } = hooks.createdServerRecord({
      nodeId: "node-id",
      displayName: "My Survival Server",
      minecraftVersion: "1.21.4",
      acceptEula: true
    }, testRuntimeProfile());

    expect(server.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(server.storageName).toBe(server.id);
    expect(server.serverDir).toBe(join(tempRoot, "servers", server.id));
    expect(server.dockerContainer).toBe(`serversentinel-${server.id}`);
    expect(server.displayName).toBe("My Survival Server");
  });

  it("validates Java args while building the remote create server record", () => {
    expect(() => hooks.createdServerRecord({
      displayName: "Unsafe",
      minecraftVersion: "1.21.4",
      acceptEula: true,
      javaArgs: "-Xmx4G; curl example.test"
    }, testRuntimeProfile())).toThrow("unsafe shell characters");
  });

  it("keeps Java args out of the shell wrapper and passes them as argv", () => {
    const command = hooks.minecraftContainerCommand({
      ...testServer(),
      javaArgs: "-Dexample=\"hello world\" -Xmx4G"
    });

    expect(command[0]).toBe("sh");
    expect(command[2]).not.toContain("-Dexample");
    expect(command).toContain("-Dexample=hello world");
    expect(command).toContain("-Xmx4G");
  });
});

describe("remote node file operation safety", () => {
  it("rejects uploads through a symlinked parent directory", async () => {
    const server = testServer();
    const serverDir = join(tempRoot, "servers", server.storageName!);
    const outsideDir = join(tempRoot, "outside");
    await mkdir(serverDir, { recursive: true });
    await mkdir(outsideDir);
    await symlink(outsideDir, join(serverDir, "mods"), process.platform === "win32" ? "junction" : "dir");

    await expect(hooks.handleCommand("files.upload", {
      server,
      parent: "mods",
      filename: "escape.txt",
      contentBase64: Buffer.from("outside").toString("base64")
    })).rejects.toThrow("symlink");

    expect(existsSync(join(outsideDir, "escape.txt"))).toBe(false);
  });

  it("rejects copies into a symlinked parent directory", async () => {
    const server = testServer();
    const serverDir = join(tempRoot, "servers", server.storageName!);
    const outsideDir = join(tempRoot, "outside");
    await mkdir(join(serverDir, "safe"), { recursive: true });
    await mkdir(outsideDir);
    await writeFile(join(serverDir, "safe", "source.txt"), "source");
    await symlink(outsideDir, join(serverDir, "escape"), process.platform === "win32" ? "junction" : "dir");

    await expect(hooks.handleCommand("files.copy", {
      server,
      path: "safe/source.txt",
      parent: "escape",
      name: "copied.txt"
    })).rejects.toThrow("symlink");

    expect(existsSync(join(outsideDir, "copied.txt"))).toBe(false);
  });

  it("rejects deleting the server root directory", async () => {
    const server = testServer();
    await mkdir(join(tempRoot, "servers", server.storageName!), { recursive: true });

    await expect(hooks.handleCommand("files.delete", {
      server,
      path: ".",
      recursive: "true"
    })).rejects.toThrow("server root");
  });

  it("requires browser editor writes to target an existing file inside the server", async () => {
    const server = testServer();
    const serverDir = join(tempRoot, "servers", server.storageName!);
    await mkdir(serverDir, { recursive: true });

    await expect(hooks.handleCommand("files.write", {
      server,
      path: "new.txt",
      content: "new"
    })).rejects.toThrow("Path does not exist");
  });

  it("allows empty generic file uploads like the local runtime", async () => {
    const server = testServer();
    const serverDir = join(tempRoot, "servers", server.storageName!);
    await mkdir(serverDir, { recursive: true });

    await hooks.handleCommand("files.upload", {
      server,
      parent: ".",
      filename: "empty.txt",
      contentBase64: ""
    });

    expect(await readFile(join(serverDir, "empty.txt"))).toEqual(Buffer.alloc(0));
  });
});

describe("remote node mod upload safety", () => {
  it("rejects path-like mod upload names", async () => {
    const server = testServer();
    await mkdir(join(tempRoot, "servers", server.storageName!, "mods"), { recursive: true });
    const jar = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

    await expect(hooks.handleCommand("mods.upload", {
      server,
      filename: "../fabric-api.jar",
      contentBase64: jar.toString("base64")
    })).rejects.toThrow("valid mod filename");
  });

  it("writes uploaded mods only to a real managed mods directory", async () => {
    const server = testServer();
    const serverDir = join(tempRoot, "servers", server.storageName!);
    const modsDir = join(serverDir, "mods");
    await mkdir(modsDir, { recursive: true });
    const jar = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

    await hooks.handleCommand("mods.upload", {
      server,
      filename: "fabric-api.jar",
      contentBase64: jar.toString("base64")
    });

    expect(await readFile(join(modsDir, "fabric-api.jar"))).toEqual(jar);
  });
});
