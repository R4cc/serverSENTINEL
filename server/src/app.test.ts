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
  findExistingServerPortConflict
} from "./app.js";
import { optionalNodeDataMount, optionalNodePanelUrl, optionalReleaseChannel } from "./http/validation.js";
import type { ManagedServer } from "./types.js";

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
});

describe("node install instructions", () => {
  it("passes the host-side node data directory for Docker sibling container binds", () => {
    const install = nodeInstallInstructions({
      panelUrl: "http://192.168.1.11:8085",
      dataMount: "/var/lib/serversentinel",
      nodeName: "mc-node-01",
      joinToken: "join-token"
    });

    expect(install.dockerCompose.environment.SS_NODE_DATA_DIR).toBe("/data");
    expect(install.dockerCompose.environment.SS_NODE_DOCKER_DATA_DIR).toBe("/var/lib/serversentinel");
    expect(install.dockerRun).toContain("-e SS_NODE_DATA_DIR='/data'");
    expect(install.dockerRun).toContain("-e SS_NODE_DOCKER_DATA_DIR='/var/lib/serversentinel'");
    expect(install.dockerRun).toContain("-v '/var/lib/serversentinel:/data'");
  });
});

describe("node force delete cleanup", () => {
  it("removes every server assigned to the deleted node and leaves other nodes alone", () => {
    const servers = [
      { id: "server-1", nodeId: "deleted-node", displayName: "One", serverDir: "/tmp/one", serverType: "fabric", createdAt: "", updatedAt: "" },
      { id: "server-2", nodeId: "kept-node", displayName: "Two", serverDir: "/tmp/two", serverType: "fabric", createdAt: "", updatedAt: "" },
      { id: "server-3", nodeId: "deleted-node", displayName: "Three", serverDir: "/tmp/three", serverType: "fabric", createdAt: "", updatedAt: "" }
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
});
