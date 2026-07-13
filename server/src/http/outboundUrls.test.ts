import { describe, expect, it } from "vitest";
import { assertMcJarsArtifactUrl, assertModrinthUrl } from "./outboundUrls.js";

describe("outbound URL restrictions", () => {
  it("allows only credential-free HTTPS Modrinth hosts", () => {
    expect(assertModrinthUrl("https://cdn.modrinth.com/data/example.jar")).toBe("https://cdn.modrinth.com/data/example.jar");
    expect(() => assertModrinthUrl("http://cdn.modrinth.com/data/example.jar")).toThrow("HTTPS");
    expect(() => assertModrinthUrl("https://modrinth.com.evil.example/data/example.jar")).toThrow("modrinth.com host");
    expect(() => assertModrinthUrl("https://127.0.0.1/internal")).toThrow("modrinth.com host");
    expect(() => assertModrinthUrl("https://user:pass@cdn.modrinth.com/data/example.jar")).toThrow("credential-free");
  });

  it("limits runtime artifacts to MCJars or the configured provider host", () => {
    expect(assertMcJarsArtifactUrl("https://versions.mcjars.app/server.jar", "https://mcjars.app")).toBe("https://versions.mcjars.app/server.jar");
    expect(assertMcJarsArtifactUrl("https://cdn.provider.example/server.jar", "https://provider.example")).toBe("https://cdn.provider.example/server.jar");
    expect(() => assertMcJarsArtifactUrl("https://127.0.0.1/server.jar", "https://mcjars.app")).toThrow("MCJars artifact URL");
    expect(() => assertMcJarsArtifactUrl("https://evil.example/server.jar", "https://mcjars.app")).toThrow("configured MCJars host");
  });
});
