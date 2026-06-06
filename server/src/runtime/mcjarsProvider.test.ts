import { describe, expect, it } from "vitest";
import { McJarsProvider } from "./mcjarsProvider.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Unavailable",
    headers: { "Content-Type": "application/json" }
  });
}

describe("MCJars runtime provider", () => {
  it("normalizes supported Fabric Minecraft versions and filters unsupported Java runtimes", async () => {
    const provider = new McJarsProvider("https://mcjars.test", undefined, async () => jsonResponse({
      success: true,
      builds: {
        "1.17.1": { type: "RELEASE", supported: true, java: 16, created: "2021-07-01T00:00:00" },
        "1.20.4": { type: "RELEASE", supported: true, java: 17, created: "2023-12-07T00:00:00" },
        "1.21.4": { type: "RELEASE", supported: true, java: 21, created: "2024-12-03T00:00:00" }
      }
    }));

    const versions = await provider.listMinecraftVersions();

    expect(versions.map((version) => version.id)).toEqual(["1.21.4", "1.20.4"]);
    expect(versions[0]).toMatchObject({ javaMajorVersion: 21, supported: true, type: "release" });
  });

  it("resolves exact Fabric loader builds into a runtime profile", async () => {
    const provider = new McJarsProvider("https://mcjars.test", "secret", async (url, init) => {
      expect(url).toBe("https://mcjars.test/api/v2/builds/FABRIC/1.21.4");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret");
      return jsonResponse({
        success: true,
        builds: [
          {
            id: 1,
            uuid: "build-1",
            versionId: "1.21.4",
            projectVersionId: "0.16.10",
            type: "FABRIC",
            experimental: false,
            jarUrl: "https://versions.mcjars.app/download/fabric/1.21.4/0.16.10/1.0.1.jar",
            jarSize: 1234
          }
        ]
      });
    });

    await expect(provider.resolveFabricServerJar({ minecraftVersion: "1.21.4", loaderVersion: "0.16.10" })).resolves.toMatchObject({
      minecraftVersion: "1.21.4",
      loader: "fabric",
      loaderVersion: "0.16.10",
      javaMajorVersion: 21,
      jarProvider: "mcjars",
      compatibilityStatus: "compatible",
      jarArtifact: {
        id: "build-1",
        filename: "fabric-server-launch.jar",
        downloadUrl: "https://versions.mcjars.app/download/fabric/1.21.4/0.16.10/1.0.1.jar",
        sizeBytes: 1234
      }
    });
  });

  it("keeps the MCJars download URL for recommended loader builds", async () => {
    const provider = new McJarsProvider("https://mcjars.test", undefined, async () => jsonResponse({
      success: true,
      builds: [
        {
          id: 1,
          uuid: "build-1",
          versionId: "26.1.2",
          projectVersionId: "0.19.3",
          type: "FABRIC",
          experimental: false,
          jarUrl: "https://versions.mcjars.app/download/fabric/26.1.2/0.19.3/1.1.1.jar",
          jarSize: 179053
        },
        {
          id: 2,
          uuid: "build-2",
          versionId: "26.1.2",
          projectVersionId: "0.19.2",
          type: "FABRIC",
          experimental: false,
          jarUrl: "https://versions.mcjars.app/download/fabric/26.1.2/0.19.2/1.1.1.jar",
          jarSize: 179053
        }
      ]
    }));

    await expect(provider.resolveFabricServerJar({ minecraftVersion: "26.1.2", loaderVersion: "latest", preferStable: true })).resolves.toMatchObject({
      loaderVersion: "0.19.3",
      jarArtifact: {
        downloadUrl: "https://versions.mcjars.app/download/fabric/26.1.2/0.19.3/1.1.1.jar"
      }
    });
  });

  it("reports provider failures as runtime resolution errors", async () => {
    const provider = new McJarsProvider("https://mcjars.test", undefined, async () => jsonResponse({ error: "down" }, 503));

    await expect(provider.resolveFabricServerJar({ minecraftVersion: "1.21.4" })).rejects.toMatchObject({
      code: "provider_unavailable",
      message: "MCJars is currently unavailable (503). Try again in a moment."
    });
  });

  it("hides low-level fetch failures behind an actionable message", async () => {
    const provider = new McJarsProvider("https://mcjars.test", undefined, async () => {
      throw new Error("fetch failed");
    });

    await expect(provider.resolveFabricServerJar({ minecraftVersion: "1.21.4" })).rejects.toMatchObject({
      code: "provider_unavailable",
      message: "ServerSentinel could not reach MCJars to fetch Fabric server files. Check internet access from the panel or node host, then try again."
    });
  });
});
