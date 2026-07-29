// @ts-expect-error Vitest runs this scan in Node, while the browser build intentionally omits Node types.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dockerContainerNameInputPattern, runtimeJarFilenameInputPattern, usernameInputPattern } from "./inputPatterns";

const inputPatterns = {
  usernameInputPattern,
  dockerContainerNameInputPattern,
  runtimeJarFilenameInputPattern
};

/**
 * The flag browsers actually use for the `pattern` attribute. It is stricter than `u`, and a
 * pattern it cannot compile is discarded rather than loosened -- so the field silently accepts
 * anything, which is exactly the failure this file exists to catch.
 */
const attributeFlag = "v";

function compiles(source: string, flags: string) {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry: { name: string; isDirectory(): boolean }) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && statSync(path).isFile() ? [path] : [];
  });
}

describe("form input patterns", () => {
  it("compiles under the flag browsers apply to the pattern attribute", () => {
    for (const [name, source] of Object.entries(inputPatterns)) {
      expect(compiles(source, attributeFlag), `${name} (${source}) must compile with the ${attributeFlag} flag`).toBe(true);
      expect(compiles(source, "u"), `${name} (${source}) must also compile with the u flag`).toBe(true);
    }
  });

  it("accepts exactly what the server-side username validator accepts", () => {
    // Mirrors validateUsername; length is enforced by minLength/maxLength on the element.
    const server = /^[a-zA-Z0-9_.-]+$/;
    const client = new RegExp(`^(?:${usernameInputPattern})$`, attributeFlag);
    for (const sample of ["abc", "a.b-c_d", "A9", "-lead", "trail-", "with space", "bang!", "sla/sh", "sem;i", ""]) {
      expect(client.test(sample), `username ${JSON.stringify(sample)}`).toBe(server.test(sample));
    }
  });

  it("accepts exactly what the server-side container name validator accepts", () => {
    // Mirrors validateDockerContainerName.
    const server = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
    const client = new RegExp(dockerContainerNameInputPattern, attributeFlag);
    const longest = `a${"b".repeat(127)}`;
    for (const sample of ["mc", "mc-server_1.0", "9lives", "-leading", "_leading", ".leading", "with space", "sla/sh", "", longest, `${longest}c`]) {
      expect(client.test(sample), `container ${JSON.stringify(sample)}`).toBe(server.test(sample));
    }
  });

  it("accepts exactly what the server-side jar filename validator accepts", () => {
    // Mirrors validateRuntimeJarFilename, which the old inline pattern did not: it allowed a `..`
    // segment the API rejects, on top of failing to compile at all.
    const server = (value: string) => Boolean(value) && !value.includes("/") && !value.includes("\\") && !value.includes("..") && value.endsWith(".jar");
    const client = new RegExp(runtimeJarFilenameInputPattern, attributeFlag);
    for (const sample of ["server.jar", "fabric-server-launch.jar", "mods/server.jar", "mods\\server.jar", "server.jar.txt", "server", "..\\server.jar", "my..server.jar", ".jar", ""]) {
      expect(client.test(sample), `jar ${JSON.stringify(sample)}`).toBe(server(sample));
    }
  });

  it("leaves no inline pattern attribute that the browser would discard", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(new URL("..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""))) {
      const contents: string = readFileSync(path, "utf8");
      for (const match of contents.matchAll(/\bpattern="([^"]*)"/g)) {
        if (!compiles(match[1], attributeFlag)) offenders.push(`${path}: ${match[1]}`);
      }
    }
    // Inline literals are allowed, but they have to compile. Anything shared belongs in
    // inputPatterns.ts so it stays paired with its server-side validator.
    expect(offenders).toEqual([]);
  });
});
