import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cronMatches,
  ensureInsideServer,
  ensureWritableInsideServer,
  nextCronRun,
  normalizePublicFilePath,
  parseDockerPorts,
  safeInstalledModFilename,
  timeZoneMinuteKey,
  validateExistingInsideServer,
  validateCron
} from "./core.js";

const server = { serverDir: resolve("test-fixtures/server") };

describe("path safety", () => {
  it("normalizes public file lock paths strictly", () => {
    expect(normalizePublicFilePath("/server.properties")).toBe("/server.properties");
    expect(normalizePublicFilePath("/mods/fabric-api.jar")).toBe("/mods/fabric-api.jar");
    expect(() => normalizePublicFilePath("mods/fabric-api.jar")).toThrow("absolute");
    expect(() => normalizePublicFilePath("/mods/../server.properties")).toThrow("normalized");
    expect(() => normalizePublicFilePath("/mods//fabric-api.jar")).toThrow("normalized");
    expect(() => normalizePublicFilePath("/mods/fabric-api.jar/")).toThrow("trailing slash");
    expect(() => normalizePublicFilePath("/mods\\fabric-api.jar")).toThrow("invalid");
  });

  it("accepts normal relative paths", () => {
    expect(ensureInsideServer(server, "mods/fabric-api.jar")).toBe(resolve(server.serverDir, "mods/fabric-api.jar"));
  });

  it("rejects parent directory traversal", () => {
    expect(() => ensureInsideServer(server, "../outside.txt")).toThrow("Path escapes");
  });

  it("rejects native absolute path escapes", () => {
    expect(() => ensureInsideServer(server, resolve(server.serverDir, "..", "outside.txt"))).toThrow("Path escapes");
  });

  it("rejects symlink escapes for existing paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "serversentinel-path-"));
    try {
      const serverDir = join(root, "server");
      const outsideDir = join(root, "outside");
      await mkdir(serverDir);
      await mkdir(outsideDir);
      await writeFile(join(outsideDir, "secret.txt"), "outside");
      await symlink(outsideDir, join(serverDir, "escape"), process.platform === "win32" ? "junction" : "dir");

      await expect(validateExistingInsideServer({ serverDir }, "escape/secret.txt")).rejects.toThrow("symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects writes through a symlinked parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "serversentinel-write-"));
    try {
      const serverDir = join(root, "server");
      const outsideDir = join(root, "outside");
      await mkdir(serverDir);
      await mkdir(outsideDir);
      await symlink(outsideDir, join(serverDir, "mods"), process.platform === "win32" ? "junction" : "dir");

      await expect(ensureWritableInsideServer({ serverDir }, "mods/evil.jar")).rejects.toThrow("symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects writes through an existing final-component symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "serversentinel-final-link-"));
    try {
      const serverDir = join(root, "server");
      const outsideTarget = join(root, "outside-target");
      await mkdir(serverDir);
      await mkdir(outsideTarget);
      await symlink(outsideTarget, join(serverDir, "server.properties"), process.platform === "win32" ? "junction" : "dir");

      await expect(ensureWritableInsideServer({ serverDir }, "server.properties")).rejects.toThrow("symbolic link");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("cron parsing and matching", () => {
  it("accepts valid five-field cron", () => {
    expect(() => validateCron("30 4 * * 1-5")).not.toThrow();
  });

  it("rejects invalid cron fields", () => {
    expect(() => validateCron("61 4 * * *")).toThrow("invalid field");
    expect(() => validateCron("0 24 * * *")).toThrow("invalid field");
    expect(() => validateCron("0 4 *")).toThrow("five fields");
  });

  it("matches expected dates", () => {
    expect(cronMatches("30 4 * * 1-5", new Date(2026, 4, 26, 4, 30))).toBe(true);
    expect(cronMatches("30 4 * * 1-5", new Date(2026, 4, 26, 4, 31))).toBe(false);
    expect(cronMatches("0 12 26 5 2", new Date(2026, 4, 26, 12, 0))).toBe(true);
  });

  it("finds the next matching run after the current minute", () => {
    const nextToday = nextCronRun("0 4 * * *", new Date(2026, 5, 6, 3, 59, 20));
    expect(nextToday && [nextToday.getDate(), nextToday.getHours(), nextToday.getMinutes()]).toEqual([6, 4, 0]);
    const nextTomorrow = nextCronRun("0 4 * * *", new Date(2026, 5, 6, 4, 0, 0));
    expect(nextTomorrow && [nextTomorrow.getDate(), nextTomorrow.getHours(), nextTomorrow.getMinutes()]).toEqual([7, 4, 0]);
  });

  it("identifies the same configured wall-clock minute across a DST overlap", () => {
    const firstOccurrence = new Date("2026-10-25T00:30:00.000Z");
    const repeatedOccurrence = new Date("2026-10-25T01:30:00.000Z");

    expect(timeZoneMinuteKey(firstOccurrence, "Europe/Vienna")).toBe("2026-10-25T02:30");
    expect(timeZoneMinuteKey(repeatedOccurrence, "Europe/Vienna")).toBe("2026-10-25T02:30");
    expect(timeZoneMinuteKey(firstOccurrence, "UTC")).not.toBe(timeZoneMinuteKey(repeatedOccurrence, "UTC"));
  });
});

describe("Docker port parsing", () => {
  it("maps a bare port to the same host and container port", () => {
    expect(parseDockerPorts("25565")).toEqual({
      exposedPorts: { "25565/tcp": {} },
      portBindings: { "25565/tcp": [{ HostPort: "25565" }] }
    });
  });

  it("maps an explicit host, container, and protocol binding", () => {
    expect(parseDockerPorts("25565:25565/tcp")).toEqual({
      exposedPorts: { "25565/tcp": {} },
      portBindings: { "25565/tcp": [{ HostPort: "25565" }] }
    });
  });

  it("maps multiple comma-separated ports", () => {
    expect(parseDockerPorts("25565:25565/tcp, 24454:24454/udp")).toEqual({
      exposedPorts: { "25565/tcp": {}, "24454/udp": {} },
      portBindings: {
        "25565/tcp": [{ HostPort: "25565" }],
        "24454/udp": [{ HostPort: "24454" }]
      }
    });
  });

  it("preserves multiple host bindings for one container port", () => {
    expect(parseDockerPorts("25565:25565/tcp,25566:25565/tcp")).toEqual({
      exposedPorts: { "25565/tcp": {} },
      portBindings: {
        "25565/tcp": [{ HostPort: "25565" }, { HostPort: "25566" }]
      }
    });
  });

  it("rejects malformed port bindings", () => {
    expect(() => parseDockerPorts("abc:25565/tcp")).toThrow("Invalid Docker port binding");
    expect(() => parseDockerPorts("25565:70000/tcp")).toThrow("Invalid Docker port binding");
    expect(() => parseDockerPorts("25565:25565/http")).toThrow("Invalid Docker port binding");
    expect(() => parseDockerPorts("25565:25565/tcp:ignored")).toThrow("Invalid Docker port binding");
    expect(() => parseDockerPorts("25565:25565/tcp/ignored")).toThrow("Invalid Docker port binding");
  });
});

describe("mod filename safety", () => {
  it("accepts valid jar filenames", () => {
    expect(safeInstalledModFilename("fabric-api.jar")).toBe("fabric-api.jar");
  });

  it("accepts disabled jar filenames", () => {
    expect(safeInstalledModFilename("fabric-api.jar.disabled")).toBe("fabric-api.jar.disabled");
  });

  it("rejects path-like filenames", () => {
    expect(() => safeInstalledModFilename("../fabric-api.jar")).toThrow("valid mod filename");
    expect(() => safeInstalledModFilename("mods/fabric-api.jar")).toThrow("valid mod filename");
  });

  it("rejects non-jar filenames", () => {
    expect(() => safeInstalledModFilename("fabric-api.zip")).toThrow("valid mod filename");
    expect(() => safeInstalledModFilename("fabric-api.jar.bak")).toThrow("valid mod filename");
  });
});
