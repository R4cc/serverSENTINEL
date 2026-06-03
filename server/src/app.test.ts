import { describe, expect, it } from "vitest";
import {
  parseLogEvent,
  requireStrictBoolean,
  validateDockerContainerName,
  validateJavaArgs,
  validateModrinthProjectId,
  nodeInstallInstructions,
  validateRuntimeJarFilename
} from "./app.js";

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
