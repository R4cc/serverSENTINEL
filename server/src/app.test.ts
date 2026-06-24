import { describe, expect, it } from "vitest";
import {
  parseLogEvent,
  requireStrictBoolean,
  validateDockerContainerName,
  validateJavaArgs,
  validateModrinthProjectId,
  nodeInstallInstructions,
  removeServersForNode,
  validateRuntimeJarFilename,
  dockerHostPortBindings,
  findExistingServerPortConflict,
  normalizeCreateServerPorts,
  allocateQueryPort,
  sessionExpired,
  sessionMaxAgeSeconds,
  validateJoinTokenTtlMinutes,
  fileContentRevision,
  assertFileRevision
} from "./app.js";
import { optionalNodeDataMount, optionalNodePanelUrl, optionalReleaseChannel } from "./http/validation.js";
import { parseMinecraftQueryResponse } from "./minecraftQuery.js";
import type { ManagedServer } from "./types.js";

function testRuntimeProfile() {
  return {
    minecraftVersion: "1.21.4",
    loader: "fabric" as const,
    loaderVersion: "0.16.10",
    javaMajorVersion: 21 as const,
    jarProvider: "mcjars" as const,
    jarArtifact: {
      filename: "fabric-server-launch.jar",
      downloadUrl: "https://example.invalid/fabric-server-launch.jar"
    },
    compatibilityStatus: "compatible" as const,
    resolvedAt: new Date().toISOString()
  };
}

describe("file revisions", () => {
  it("detects content changes before saving", () => {
    const acquired = fileContentRevision("original");
    expect(() => assertFileRevision(acquired, acquired, fileContentRevision("changed")))
      .toThrow("The file changed after editing began");
    expect(() => assertFileRevision(acquired, acquired, acquired)).not.toThrow();
  });
});

describe("parseLogEvent log parsing and timestamp extraction", () => {
  it("parses modern Minecraft log format with time-of-day timestamp", () => {
    const line = "[12:34:56] [Server thread/INFO]: Antigravity joined the game";
    const event = parseLogEvent(line, "logs/latest.log", 1);
    expect(event).not.toBeNull();
    expect(event!.timestamp).toBe("12:34:56");
    expect(event!.type).toBe("success");
    expect(event!.text).toBe("Player joined: Antigravity");
    expect(event!.eventType).toBe("player_joined");
    expect(event!.signature).toBe("player_joined:antigravity");
  });

  it("parses wrapper log format with full date-time timestamp", () => {
    const line = "[2026-05-29 12:34:56] [Server thread/INFO]: Antigravity left the game";
    const event = parseLogEvent(line, "logs/latest.log", 2);
    expect(event).not.toBeNull();
    expect(event!.timestamp).toBe(new Date("2026-05-29T12:34:56").toISOString());
    expect(event!.type).toBe("info");
    expect(event!.text).toBe("Player left: Antigravity");
    expect(event!.eventType).toBe("player_left");
  });

  it("correctly identifies server start events", () => {
    const line = "[12:34:56] [Server thread/INFO]: Done (5.132s)! For help, type \"help\"";
    const event = parseLogEvent(line, "logs/latest.log", 3);
    expect(event).not.toBeNull();
    expect(event!.text).toBe("Server started");
    expect(event!.type).toBe("success");
    expect(event!.signature).toBe("server_started");
  });

  it("correctly identifies server stopped events from shutdown lines", () => {
    const line = "[12:34:56] [Server thread/INFO]: Stopping server";
    const event = parseLogEvent(line, "logs/latest.log", 4);
    expect(event).not.toBeNull();
    expect(event!.text).toBe("Server stopped");
    expect(event!.eventType).toBe("server_stopped");
  });

  it("ignores server save lines because they are not recent events", () => {
    const line = "[12:34:56] [Server thread/INFO]: Saved the game";
    const event = parseLogEvent(line, "logs/latest.log", 4);
    expect(event).toBeNull();
  });

  it("identifies explicit mod disabled events", () => {
    const line = "[12:34:56] [Server thread/WARN]: Disabled mod sodium.jar";
    const event = parseLogEvent(line, "logs/latest.log", 4);
    expect(event).not.toBeNull();
    expect(event!.text).toBe("Mod disabled: sodium.jar");
    expect(event!.eventType).toBe("mod_disabled");
    expect(event!.signature).toBe("mod_disabled:sodium.jar");
  });

  it("identifies explicit crash report events", () => {
    const line = "[12:34:56] [Server thread/ERROR]: Encountered an unexpected exception";
    const event = parseLogEvent(line, "logs/latest.log", 4);
    expect(event).not.toBeNull();
    expect(event!.text).toBe("Server crashed");
    expect(event!.eventType).toBe("server_crashed");
  });

  it("ignores file listing lines from ls -la even if they contain 'error'", () => {
    const line = "-rw-r--r-- 1 root root    0 May 29 12:34 error.log";
    const event = parseLogEvent(line, "docker", 5);
    expect(event).toBeNull();
  });

  it("ignores raw filenames containing 'error' or 'crash'", () => {
    const line1 = "error.log";
    expect(parseLogEvent(line1, "docker", 6)).toBeNull();

    const line2 = "hs_err_pid1234.log";
    expect(parseLogEvent(line2, "docker", 7)).toBeNull();
  });

  it("ignores broad errors and warnings that are not allowlisted event types", () => {
    const line = "java.lang.NullPointerException: something went wrong";
    const event = parseLogEvent(line, "logs/latest.log", 8);
    expect(event).toBeNull();
  });

  it("ignores Fabric dependency tree lines and JVM informational messages", () => {
    expect(parseLogEvent("|-- fabric-crash-report-info-v1 1.0.3+9f78a5a839", "logs/latest.log", 9)).toBeNull();
    expect(parseLogEvent("[12:34:56] [main/INFO]: Distant Horizons: G1 Garbage collector detected.", "logs/latest.log", 10)).toBeNull();
  });
});

describe("Minecraft Query metrics parsing", () => {
  it("parses player counts and player names from a full query response", () => {
    const sessionId = Buffer.from([1, 2, 3, 4]);
    const payload = Buffer.concat([
      Buffer.from("hostname\0Test Server\0numplayers\0", "utf8"),
      Buffer.from("3\0maxplayers\0", "utf8"),
      Buffer.from("20\0", "utf8"),
      Buffer.from([0, 1, 0]),
      Buffer.from("player_\0Alex\0Steve\0Sam\0\0", "utf8")
    ]);
    const packet = Buffer.concat([Buffer.from([0]), sessionId, Buffer.alloc(11), payload]);

    expect(parseMinecraftQueryResponse(packet, sessionId)).toEqual({
      responding: true,
      playersOnline: 3,
      maxPlayers: 20,
      playerNames: ["Alex", "Steve", "Sam"]
    });
  });
});

describe("security validation helpers", () => {
  it("requires true booleans instead of truthy strings", () => {
    expect(requireStrictBoolean(true, "forceIncompatible")).toBe(true);
    expect(requireStrictBoolean(false, "forceIncompatible")).toBe(false);
    expect(() => requireStrictBoolean("false", "forceIncompatible")).toThrow("must be a boolean");
  });

  it("rejects unsafe Java shell metacharacters", () => {
    expect(validateJavaArgs("-Xms2G -Xmx4G")).toBe("-Xms2G -Xmx4G");
    expect(() => validateJavaArgs("-Xmx4G; curl example.test")).toThrow("unsafe shell characters");
    expect(() => validateJavaArgs("$(touch owned)")).toThrow("unsafe shell characters");
  });

  it("validates Docker and Modrinth identifiers conservatively", () => {
    expect(validateDockerContainerName("serversentinel-main.1")).toBe("serversentinel-main.1");
    expect(() => validateDockerContainerName("../docker")).toThrow("Docker container name");
    expect(validateModrinthProjectId("fabric-api")).toBe("fabric-api");
    expect(() => validateModrinthProjectId("bad/project")).toThrow("Modrinth project id");
  });

  it("requires runtime server jar names to stay local jar filenames", () => {
    expect(validateRuntimeJarFilename("fabric-server-launch.jar")).toBe("fabric-server-launch.jar");
    expect(() => validateRuntimeJarFilename("../fabric-server-launch.jar")).toThrow("local .jar filename");
    expect(() => validateRuntimeJarFilename("server.txt")).toThrow("local .jar filename");
  });

  it("validates node setup inputs without credentials or multiline mounts", () => {
    expect(optionalNodePanelUrl("http://192.168.1.11:8085")).toBe("http://192.168.1.11:8085");
    expect(() => optionalNodePanelUrl("ftp://panel.local")).toThrow("http or https");
    expect(() => optionalNodePanelUrl("http://user:pass@panel.local")).toThrow("embedded credentials");
    expect(optionalNodeDataMount("/srv/serversentinel")).toBe("/srv/serversentinel");
    expect(() => optionalNodeDataMount("/srv/data\nSS_JOIN_TOKEN=bad")).toThrow("single-line");
    expect(optionalReleaseChannel("beta")).toBe("beta");
    expect(() => optionalReleaseChannel("nightly")).toThrow("Release channel");
  });

  it("bounds node join token expiry to deliberate short-lived values", () => {
    expect(validateJoinTokenTtlMinutes(undefined)).toBe(60);
    expect(validateJoinTokenTtlMinutes(5)).toBe(5);
    expect(validateJoinTokenTtlMinutes(1440)).toBe(1440);
    expect(() => validateJoinTokenTtlMinutes(4)).toThrow("Join token expiry");
    expect(() => validateJoinTokenTtlMinutes(1441)).toThrow("Join token expiry");
    expect(() => validateJoinTokenTtlMinutes(30.5)).toThrow("Join token expiry");
  });

  it("expires server-side sessions even if a stale cookie is still sent", () => {
    const now = Date.now();
    expect(sessionExpired({ createdAt: new Date(now - sessionMaxAgeSeconds * 1000 + 1000).toISOString() }, now)).toBe(false);
    expect(sessionExpired({ createdAt: new Date(now - sessionMaxAgeSeconds * 1000 - 1000).toISOString() }, now)).toBe(true);
    expect(sessionExpired({ createdAt: "not-a-date" }, now)).toBe(true);
  });
});

describe("node install instructions", () => {
  it("passes the host-side node data directory for Docker sibling container binds", () => {
    const install = nodeInstallInstructions({
      panelUrl: "http://192.168.1.11:8085",
      dataMount: "/var/lib/serversentinel",
      nodeName: "mc-node-01",
      joinToken: "join-token"
    });

    expect(install.protocolVersion).toBe("2.0");
    expect(install.dockerCompose.environment.SERVERSENTINEL_DATA_DIR).toBe("/data");
    expect(install.dockerCompose.environment.SERVERSENTINEL_DOCKER_DATA_DIR).toBe("/var/lib/serversentinel");
    expect(install.dockerCompose.restart).toBe("unless-stopped");
    expect(install.dockerRun).toContain("--restart unless-stopped");
    expect(install.dockerRun).toContain("--env SERVERSENTINEL_DATA_DIR='/data'");
    expect(install.dockerRun).toContain("--env SERVERSENTINEL_DOCKER_DATA_DIR='/var/lib/serversentinel'");
    expect(install.dockerRun).toContain("--volume '/var/lib/serversentinel:/data'");
  });
});

describe("node force delete cleanup", () => {
  it("removes every server assigned to the deleted node and leaves other nodes alone", () => {
    const servers = [
      { id: "server-1", nodeId: "deleted-node", displayName: "One", serverDir: "/tmp/one", runtimeProfile: testRuntimeProfile(), serverType: "fabric", createdAt: "", updatedAt: "" },
      { id: "server-2", nodeId: "kept-node", displayName: "Two", serverDir: "/tmp/two", runtimeProfile: testRuntimeProfile(), serverType: "fabric", createdAt: "", updatedAt: "" },
      { id: "server-3", nodeId: "deleted-node", displayName: "Three", serverDir: "/tmp/three", runtimeProfile: testRuntimeProfile(), serverType: "fabric", createdAt: "", updatedAt: "" }
    ] satisfies ManagedServer[];

    expect(removeServersForNode(servers, "deleted-node")).toBe(2);
    expect(servers.map((server) => server.id)).toEqual(["server-2"]);
  });
});

describe("server port conflict detection", () => {
  const servers = [
    {
      id: "server-1",
      nodeId: "node-a",
      displayName: "Survival",
      serverDir: "/tmp/survival",
      dockerPorts: "25565:25565/tcp,25565:25565/udp",
      runtimeProfile: testRuntimeProfile(),
      serverType: "fabric",
      createdAt: "",
      updatedAt: ""
    },
    {
      id: "server-2",
      nodeId: "node-b",
      displayName: "Creative",
      serverDir: "/tmp/creative",
      dockerPorts: "25565:25565/tcp",
      runtimeProfile: testRuntimeProfile(),
      serverType: "fabric",
      createdAt: "",
      updatedAt: ""
    }
  ] satisfies ManagedServer[];

  it("extracts host ports by protocol from Docker port bindings", () => {
    expect(dockerHostPortBindings("25565:25565/tcp,19132:19132/udp")).toEqual([
      { port: "25565", protocol: "tcp", key: "25565/tcp" },
      { port: "19132", protocol: "udp", key: "19132/udp" }
    ]);
  });

  it("detects duplicate host ports on the same node", () => {
    const conflict = findExistingServerPortConflict(servers, "node-a", "25565:25566/tcp");
    expect(conflict?.ownerName).toBe('managed server "Survival"');
    expect(conflict?.port).toEqual({ port: "25565", protocol: "tcp", key: "25565/tcp" });
  });

  it("allows the same host port on a different node or different protocol", () => {
    expect(findExistingServerPortConflict(servers, "node-b", "25565:25566/tcp", "server-2")).toBeNull();
    expect(findExistingServerPortConflict(servers, "node-a", "25566:25565/tcp")).toBeNull();
    expect(findExistingServerPortConflict(servers, "node-a", "25565:25565/udp", "server-1")).toBeNull();
  });

  it("adds a required non-removable advanced Query UDP port when creating a server", () => {
    const normalized = normalizeCreateServerPorts({ serverPort: "25565" }, [], "node-a");
    expect(normalized.queryPort).toBe(25566);
    expect(normalized.dockerPorts).toContain("25566:25566/udp");
    expect(normalized.managedPorts.find((port) => port.type === "query")).toMatchObject({
      name: "Minecraft Query",
      protocol: "udp",
      internalPort: 25566,
      externalPort: 25566,
      required: true,
      removable: false,
      advanced: true
    });
  });

  it("allocates the next free Query port when 25566 is already used on the node", () => {
    const normalized = normalizeCreateServerPorts({
      serverPort: "25565"
    }, [{
      id: "server-query",
      nodeId: "node-a",
      displayName: "Query Owner",
      serverDir: "/tmp/query-owner",
      dockerPorts: "25566:25566/udp",
      managedPorts: [{
        id: "minecraft-query",
        name: "Minecraft Query",
        type: "query",
        protocol: "udp",
        internalPort: 25566,
        externalPort: 25566,
        required: true,
        removable: false,
        advanced: true
      }],
      runtimeProfile: testRuntimeProfile(),
      serverType: "fabric",
      createdAt: "",
      updatedAt: ""
    }], "node-a");

    expect(normalized.queryPort).toBe(25567);
    expect(normalized.dockerPorts).toContain("25567:25567/udp");
  });

  it("does not allocate a Query port that conflicts with the main Minecraft port", () => {
    const normalized = normalizeCreateServerPorts({ serverPort: "25566" }, [], "node-a");
    expect(normalized.queryPort).toBe(25567);
  });

  it("rejects an explicit Query port already used on the same node", () => {
    expect(() => allocateQueryPort(servers, "node-a", "25567:25567/tcp", "25565")).toThrow("already used");
  });
});
