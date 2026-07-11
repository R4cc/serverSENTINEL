import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedServer, ServerRuntimeProfile } from "../types.js";

type NodeAgentTestHooks = typeof import("./nodeAgent.js").__nodeAgentTestHooks;

let tempRoot: string;
let hooks: NodeAgentTestHooks;
let mockDockerAvailable = false;
let mockDockerRequest: ReturnType<typeof vi.fn>;
let mockDockerBufferRequest: ReturnType<typeof vi.fn>;
let mockDockerJsonRequest: ReturnType<typeof vi.fn>;
let mockSendDockerContainerStdinLine: ReturnType<typeof vi.fn>;

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
    runtimeProfile: testRuntimeProfile(),
    dockerImage: "eclipse-temurin:21-jre",
    dockerPorts: "25565:25565/tcp,25566:25566/udp",
    javaArgs: "-Xms2G -Xmx4G",
    createdAt: "",
    updatedAt: ""
  };
}

async function loadHooks() {
  vi.resetModules();
  process.env.SERVERSENTINEL_DATA_DIR = tempRoot;
  vi.doMock("../docker/dockerClient.js", () => ({
    dockerAvailable: () => mockDockerAvailable,
    dockerBufferRequest: mockDockerBufferRequest,
    dockerErrorMessage: (body: string, statusCode?: number) => body || `Docker API returned ${statusCode ?? "an error"}`,
    dockerJsonRequest: mockDockerJsonRequest,
    dockerRequest: mockDockerRequest,
    sendDockerContainerStdinLine: mockSendDockerContainerStdinLine
  }));
  return (await import("./nodeAgent.js")).__nodeAgentTestHooks;
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "serversentinel-node-agent-"));
  mockDockerAvailable = false;
  mockDockerRequest = vi.fn();
  mockDockerBufferRequest = vi.fn();
  mockDockerJsonRequest = vi.fn();
  mockSendDockerContainerStdinLine = vi.fn();
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
      runtime: { minecraftVersion: "1.21.4" },
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
      runtime: { minecraftVersion: "1.21.4" },
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

  it("passes the configured time zone to managed Minecraft containers", () => {
    expect(hooks.minecraftContainerEnvironment()).toContain(`TZ=${process.env.TZ}`);
  });

  it("preserves custom Minecraft container networks without Docker-assigned endpoint fields", () => {
    const inspect = {
      NetworkSettings: {
        Networks: {
          minecraft: {
            IPAMConfig: { IPv4Address: "172.30.0.8" },
            Aliases: ["survival"],
            DriverOpts: { "com.example.option": "enabled" },
            EndpointID: "endpoint-id",
            NetworkID: "network-id",
            IPAddress: "172.30.0.12",
            Gateway: "172.30.0.1",
            MacAddress: "02:42:ac:1e:00:0c"
          }
        }
      }
    };

    expect(hooks.createNetworkingConfig(inspect)).toEqual({
      EndpointsConfig: {
        minecraft: {
          IPAMConfig: { IPv4Address: "172.30.0.8" },
          Aliases: ["survival"],
          DriverOpts: { "com.example.option": "enabled" }
        }
      }
    });
  });

  it("prefers the old Minecraft container networks and falls back to node networks", () => {
    const minecraftInspect = { NetworkSettings: { Networks: { minecraft: { Aliases: ["survival"] } } } };
    const nodeInspect = { NetworkSettings: { Networks: { panel: { Aliases: ["node"] } } } };

    expect(hooks.minecraftContainerNetworkingConfig(minecraftInspect, nodeInspect)).toEqual(hooks.createNetworkingConfig(minecraftInspect));
    expect(hooks.minecraftContainerNetworkingConfig({ NetworkSettings: { Networks: {} } }, nodeInspect)).toEqual(hooks.createNetworkingConfig(nodeInspect));
  });
});

describe("remote node Docker container recreation", () => {
  function managedStoppedInspect(server: ManagedServer) {
    return {
      Id: "minecraft-container-id",
      Name: `/${server.dockerContainer}`,
      State: { Running: false, Status: "exited" },
      Config: {
        Labels: {
          "serversentinel.managed": "true",
          "serversentinel.serverId": server.id,
          "serversentinel.config-hash": "stale"
        },
        OpenStdin: true,
        AttachStdin: true
      },
      NetworkSettings: {
        Networks: {
          minecraft: {
            Aliases: ["survival"],
            EndpointID: "endpoint-id",
            NetworkID: "network-id",
            IPAddress: "172.30.0.12",
            Gateway: "172.30.0.1"
          }
        }
      }
    };
  }

  it("carries custom networks across a stopped port-edit recreate", async () => {
    mockDockerAvailable = true;
    mockDockerJsonRequest.mockResolvedValue({});
    const server = {
      ...testServer(),
      dockerContainer: "serversentinel-survival",
      managedPorts: [{
        id: "minecraft-query",
        name: "Minecraft Query",
        type: "query" as const,
        protocol: "udp" as const,
        internalPort: 25566,
        externalPort: 25566,
        required: true,
        removable: false,
        advanced: true
      }]
    };
    await mkdir(join(tempRoot, "servers", server.storageName!), { recursive: true });
    const inspect = managedStoppedInspect(server);
    let inspectCount = 0;
    mockDockerRequest.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/containers/serversentinel-survival/json") {
        inspectCount += 1;
        if (inspectCount <= 5) return inspect;
        throw new Error("No such container");
      }
      if (method === "GET" && path === "/images/eclipse-temurin%3A21-jre/json") return {};
      if (method === "DELETE" && path === "/containers/serversentinel-survival?force=1") return {};
      throw new Error(`Unexpected Docker request ${method} ${path}`);
    });

    await hooks.handleCommand("server.update", {
      server,
      input: { dockerPorts: "25567:25565/tcp,25566:25566/udp" }
    });

    expect(mockDockerRequest).toHaveBeenCalledWith("DELETE", "/containers/serversentinel-survival?force=1", [204, 404]);
    expect(mockDockerJsonRequest).toHaveBeenCalledWith(
      "POST",
      "/containers/create?name=serversentinel-survival",
      expect.objectContaining({
        NetworkingConfig: {
          EndpointsConfig: {
            minecraft: {
              Aliases: ["survival"],
              IPAMConfig: undefined,
              DriverOpts: undefined
            }
          }
        }
      }),
      [201, 409]
    );
    const createBody = mockDockerJsonRequest.mock.calls.find((call) => call[1] === "/containers/create?name=serversentinel-survival")?.[2] as { NetworkingConfig?: unknown };
    expect(JSON.stringify(createBody.NetworkingConfig)).not.toContain("EndpointID");
    expect(JSON.stringify(createBody.NetworkingConfig)).not.toContain("172.30.0.12");
  });
});

describe("remote node file operation safety", () => {
  it("allows copies into the mods directory when runtime status is unavailable", async () => {
    const server = { ...testServer(), dockerContainer: "serversentinel-survival" };
    await mkdir(join(tempRoot, "servers", server.storageName!, "safe"), { recursive: true });
    await mkdir(join(tempRoot, "servers", server.storageName!, "mods"), { recursive: true });
    await writeFile(join(tempRoot, "servers", server.storageName!, "safe", "source.jar"), "source");

    await hooks.handleCommand("files.copy", {
      server,
      path: "safe/source.jar",
      parent: "mods",
      name: "fabric-api.jar"
    });
    expect(await readFile(join(tempRoot, "servers", server.storageName!, "mods", "fabric-api.jar"), "utf8")).toBe("source");
  });

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
  it("allows mod uploads when runtime status is unavailable", async () => {
    const server = { ...testServer(), dockerContainer: "serversentinel-survival" };
    await mkdir(join(tempRoot, "servers", server.storageName!, "mods"), { recursive: true });
    const jar = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

    await hooks.handleCommand("mods.upload", {
      server,
      filename: "fabric-api.jar",
      contentBase64: jar.toString("base64")
    });
    expect(await readFile(join(tempRoot, "servers", server.storageName!, "mods", "fabric-api.jar"))).toEqual(jar);
  });

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

  it("lists stable file hashes without requiring Modrinth metadata on the node", async () => {
    const server = testServer();
    const modsDir = join(tempRoot, "servers", server.storageName!, "mods");
    await mkdir(modsDir, { recursive: true });
    await writeFile(join(modsDir, "fabric-api.jar"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const result = await hooks.handleCommand("mods.list", { server }) as { mods: Array<Record<string, unknown>> };

    expect(result.mods).toHaveLength(1);
    expect(result.mods[0]).toMatchObject({ filename: "fabric-api.jar", enabled: true });
    expect(result.mods[0].sha1).toMatch(/^[a-f0-9]{40}$/);
    expect(result.mods[0]).not.toHaveProperty("modrinth");
    expect(result.mods[0]).not.toHaveProperty("iconUrl");
  });
});

describe("node self-update container cleanup", () => {
  function nodeInspect(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      Id: "old-node-id",
      Name: "/serversentinel-node",
      State: { Running: true, Status: "running" },
      Config: {
        Image: "nl2109/serversentinel:old",
        Env: [
          "SS_MODE=node",
          "SS_PANEL_URL=https://panel.example.test",
          "SERVERSENTINEL_BUILD_ID=old-primary-build",
          "SS_BUILD_ID=old-short-build",
          "GITHUB_SHA=old-github-build",
          "COMMIT_SHA=old-commit-build",
          "SOURCE_COMMIT=old-source-build",
          "RAILWAY_GIT_COMMIT_SHA=old-railway-build"
        ],
        Labels: { "serversentinel.test": "true" }
      },
      HostConfig: {},
      NetworkSettings: {},
      ...overrides
    };
  }

  it("removes the previous container after the replacement starts successfully", async () => {
    mockDockerAvailable = true;
    mockDockerBufferRequest.mockImplementation(async (_method: string, path: string) => path.includes("/logs?") ? Buffer.from("Node session accepted for node-1") : Buffer.alloc(0));
    mockDockerJsonRequest.mockResolvedValue({});
    mockDockerRequest.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path.includes("/rename?")) return {};
      if (method === "POST" && path === "/containers/serversentinel-node/start") return {};
      if (method === "GET" && path === "/containers/serversentinel-node/json") {
        return { Id: "new-node-id", Name: "/serversentinel-node", State: { Running: true, Status: "running" } };
      }
      if (method === "GET" && path === "/containers/json?all=1") return [];
      if (method === "DELETE" && path.startsWith("/containers/serversentinel-node-previous-")) return {};
      throw new Error(`Unexpected Docker request ${method} ${path}`);
    });

    await hooks.selfUpdateContainer(nodeInspect(), "nl2109/serversentinel:new", "serversentinel-node", join(tempRoot, "plan.json"));

    expect(mockDockerRequest).toHaveBeenCalledWith("POST", expect.stringMatching(/^\/containers\/old-node-id\/rename\?name=serversentinel-node-previous-\d+$/), 204);
    expect(mockDockerJsonRequest).toHaveBeenCalledWith(
      "POST",
      "/containers/create?name=serversentinel-node",
      expect.objectContaining({
        Image: "nl2109/serversentinel:new",
        Env: ["SS_MODE=node", "SS_PANEL_URL=https://panel.example.test"]
      }),
      201
    );
    expect(mockDockerRequest).toHaveBeenCalledWith("POST", "/containers/serversentinel-node/start", 204);
    expect(mockDockerBufferRequest).toHaveBeenCalledWith("GET", "/containers/serversentinel-node/logs?stdout=1&stderr=1&tail=100", 200, 10_000);
    expect(mockDockerRequest).toHaveBeenCalledWith("DELETE", expect.stringMatching(/^\/containers\/serversentinel-node-previous-\d+\?force=1&v=1$/), [204, 404]);
    expect(mockDockerRequest).not.toHaveBeenCalledWith("POST", expect.stringContaining("/stop?t=10"), expect.anything());
  });

  it("preserves the previous container when the replacement fails health verification", async () => {
    mockDockerAvailable = true;
    mockDockerBufferRequest.mockResolvedValue(Buffer.alloc(0));
    mockDockerJsonRequest.mockResolvedValue({});
    mockDockerRequest.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path.includes("/rename?")) return {};
      if (method === "POST" && path === "/containers/serversentinel-node/start") return {};
      if (method === "GET" && path === "/containers/serversentinel-node/json") {
        return { Id: "new-node-id", Name: "/serversentinel-node", State: { Running: true, Status: "running", Health: { Status: "unhealthy" } } };
      }
      throw new Error(`Unexpected Docker request ${method} ${path}`);
    });

    await expect(hooks.selfUpdateContainer(nodeInspect(), "nl2109/serversentinel:new", "serversentinel-node", join(tempRoot, "plan.json")))
      .rejects.toThrow("Previous container was retained");

    expect(mockDockerRequest).not.toHaveBeenCalledWith("DELETE", expect.any(String), expect.anything());
  });

  it("cleanup does not delete the active node container", async () => {
    mockDockerRequest.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/containers/json?all=1") {
        return [
          { Id: "active", Names: ["/serversentinel-node"], State: "running" },
          { Id: "previous", Names: ["/serversentinel-node-previous-100"], State: "exited" }
        ];
      }
      if (method === "DELETE" && path === "/containers/serversentinel-node-previous-100?force=1&v=1") return {};
      throw new Error(`Unexpected Docker request ${method} ${path}`);
    });

    await hooks.cleanupPreviousNodeContainers("serversentinel-node");

    expect(mockDockerRequest).toHaveBeenCalledWith("DELETE", "/containers/serversentinel-node-previous-100?force=1&v=1", [204, 404]);
    expect(mockDockerRequest).not.toHaveBeenCalledWith("DELETE", "/containers/serversentinel-node?force=1&v=1", [204, 404]);
  });

  it("cleanup ignores unrelated containers", async () => {
    mockDockerRequest.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/containers/json?all=1") {
        return [
          { Id: "other", Names: ["/other-node-previous-100"], State: "exited" },
          { Id: "project", Names: ["/serversentinel-node-previous-100"], State: "exited" },
          { Id: "running-previous", Names: ["/serversentinel-node-previous-200"], State: "running" }
        ];
      }
      if (method === "DELETE" && path === "/containers/serversentinel-node-previous-100?force=1&v=1") return {};
      throw new Error(`Unexpected Docker request ${method} ${path}`);
    });

    const result = await hooks.cleanupPreviousNodeContainers("serversentinel-node");

    expect(result.removed).toEqual(["serversentinel-node-previous-100"]);
    expect(mockDockerRequest).not.toHaveBeenCalledWith("DELETE", "/containers/other-node-previous-100?force=1&v=1", [204, 404]);
    expect(mockDockerRequest).not.toHaveBeenCalledWith("DELETE", "/containers/serversentinel-node-previous-200?force=1&v=1", [204, 404]);
  });
});
