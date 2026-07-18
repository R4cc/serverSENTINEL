import { describe, expect, it, vi } from "vitest";
import { PaperDownloadsProvider, paperBuildNumber } from "./paperProvider.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Unavailable",
    headers: { "Content-Type": "application/json" }
  });
}

function build(id: number, channel: "STABLE" | "BETA" = "STABLE") {
  return {
    id,
    time: "2026-05-11T11:43:09Z",
    channel,
    downloads: {
      "server:default": {
        name: `paper-1.21.11-${id}.jar`,
        checksums: { sha256: "5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba" },
        size: 54_846_016,
        url: `https://fill-data.papermc.io/v1/objects/5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba/paper-1.21.11-${id}.jar`
      }
    }
  };
}

describe("PaperMC downloads provider", () => {
  it("normalizes supported releases and prereleases from the official project response", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["User-Agent"]).toContain("https://github.com/R4cc/serverSENTINEL");
      return jsonResponse({
        project: { id: "paper", name: "Paper" },
        versions: {
          "26.1": ["26.1.2"],
          "1.21": ["1.21.11", "1.21.11-rc1"],
          "1.17": ["1.17.1"]
        }
      });
    });
    const provider = new PaperDownloadsProvider("https://fill.papermc.test", fetchMock as typeof fetch);

    await expect(provider.listMinecraftVersions("paper")).resolves.toEqual([
      { id: "26.1.2", type: "release", supported: true, javaMajorVersion: 25 },
      { id: "1.21.11", type: "release", supported: true, javaMajorVersion: 21 },
      { id: "1.21.11-rc1", type: "snapshot", supported: true, javaMajorVersion: 21 }
    ]);
  });

  it("lists newest builds first and recommends the newest stable build", async () => {
    const provider = new PaperDownloadsProvider("https://fill.papermc.test", async () => jsonResponse([
      build(130),
      build(132),
      build(133, "BETA"),
      build(131)
    ]));

    await expect(provider.listRuntimeVersions("paper", "1.21.11")).resolves.toEqual([
      { id: "133", runtimeVersion: "133", stable: false, recommended: false, buildId: "133" },
      { id: "132", runtimeVersion: "132", stable: true, recommended: true, buildId: "132" },
      { id: "131", runtimeVersion: "131", stable: true, recommended: false, buildId: "131" },
      { id: "130", runtimeVersion: "130", stable: true, recommended: false, buildId: "130" }
    ]);
  });

  it("recommends the newest Minecraft release that has a stable Paper build", async () => {
    const provider = new PaperDownloadsProvider("https://fill.papermc.test", async (url) => {
      const path = String(url);
      if (path.endsWith("/v3/projects/paper")) {
        return jsonResponse({ versions: { "26.2": ["26.2"], "26.1": ["26.1.2"], "1.21": ["1.21.11"] } });
      }
      if (path.includes("/versions/26.2/builds")) return jsonResponse([build(140, "BETA")]);
      return jsonResponse([build(132)]);
    });

    const versions = await provider.listMinecraftVersions("paper");

    expect(versions.find((version) => version.id === "26.2")?.recommended).toBeUndefined();
    expect(versions.find((version) => version.id === "26.1.2")?.recommended).toBe(true);
    expect(versions.filter((version) => version.recommended)).toHaveLength(1);
  });

  it("resolves the newest stable build with size and SHA-256 integrity metadata", async () => {
    const provider = new PaperDownloadsProvider("https://fill.papermc.test", async () => jsonResponse([
      build(133, "BETA"),
      build(132)
    ]));

    await expect(provider.resolveServerJar({ runtimeType: "paper", minecraftVersion: "1.21.11", runtimeVersion: "latest", preferStable: true })).resolves.toMatchObject({
      minecraftVersion: "1.21.11",
      runtimeType: "paper",
      runtimeVersion: "132",
      javaMajorVersion: 21,
      jarProvider: "papermc",
      compatibilityStatus: "compatible",
      jarArtifact: {
        id: "1.21.11:132",
        filename: "paper.jar",
        sizeBytes: 54_846_016,
        sha256: "5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba"
      }
    });
  });

  it("accepts explicit development builds and legacy composite build identifiers", async () => {
    const provider = new PaperDownloadsProvider("https://fill.papermc.test", async () => jsonResponse([build(133, "BETA"), build(132)]));

    await expect(provider.resolveServerJar({ runtimeType: "paper", minecraftVersion: "1.21.11", runtimeVersion: "1.21.11-133" })).resolves.toMatchObject({
      runtimeVersion: "133"
    });
    expect(paperBuildNumber("paper-1.21.11-132.jar", "1.21.11")).toBe("132");
  });

  it("does not silently fall back to an unstable build", async () => {
    const provider = new PaperDownloadsProvider("https://fill.papermc.test", async () => jsonResponse([build(133, "BETA")]));

    await expect(provider.resolveServerJar({ runtimeType: "paper", minecraftVersion: "1.21.11", preferStable: true })).rejects.toMatchObject({
      code: "no_runtime_artifact",
      message: "PaperMC has no stable Paper build for Minecraft 1.21.11"
    });
  });

  it("rejects download URLs outside PaperMC's domains", async () => {
    const unsafe = build(132);
    unsafe.downloads["server:default"].url = "https://example.invalid/paper.jar";
    const provider = new PaperDownloadsProvider("https://fill.papermc.test", async () => jsonResponse([unsafe]));

    await expect(provider.resolveServerJar({ runtimeType: "paper", minecraftVersion: "1.21.11" })).rejects.toThrow("papermc.io host");
  });

  it("returns actionable provider failures", async () => {
    const provider = new PaperDownloadsProvider("https://fill.papermc.test", async () => jsonResponse({ message: "down" }, 503));

    await expect(provider.resolveServerJar({ runtimeType: "paper", minecraftVersion: "1.21.11" })).rejects.toMatchObject({
      code: "provider_unavailable",
      message: "PaperMC is currently unavailable (503). Try again in a moment."
    });
  });
});
