import type { FastifyInstance } from "fastify";
import { requireRequestPermission, requireVersionCatalogAccess } from "../auth/sessionService.js";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { parseServerRuntimeType, serverJarProvider } from "../servers/provisioning.js";

export function registerVersionCatalogRoutes(app: FastifyInstance) {
app.get("/api/fabric/versions", async (request) => {
  await requireVersionCatalogAccess(request);
  const game = await serverJarProvider.listMinecraftVersions("fabric");
  const latestGame = game.find((version) => version.type === "release") ?? game[0];
  const loader = latestGame ? await serverJarProvider.listRuntimeVersions("fabric", latestGame.id).catch(() => []) : [];
  return {
    game: game.map((version) => ({ version: version.id, stable: version.type === "release" && version.supported, type: version.type ?? "unknown" })),
    loader: loader.slice(0, 20).map((version) => ({ version: version.runtimeVersion, stable: version.stable !== false })),
    installer: []
  };
});

app.get("/api/runtime/types", async (request) => {
  await requireVersionCatalogAccess(request);
  return {
    runtimes: (["fabric", "paper"] as const).map((runtimeType) => serverRuntimeDefinition(runtimeType))
  };
});

app.get<{ Params: { runtimeType: string } }>("/api/runtime/:runtimeType/minecraft-versions", async (request) => {
  await requireVersionCatalogAccess(request);
  const runtimeType = parseServerRuntimeType(request.params.runtimeType);
  return { runtimeType, versions: await serverJarProvider.listMinecraftVersions(runtimeType) };
});

app.get<{ Params: { runtimeType: string }; Querystring: { minecraftVersion?: string; refresh?: string } }>("/api/runtime/:runtimeType/versions", async (request) => {
  await requireVersionCatalogAccess(request);
  const minecraftVersion = request.query.minecraftVersion?.trim();
  if (!minecraftVersion) {
    throw new Error("minecraftVersion is required");
  }
  const runtimeType = parseServerRuntimeType(request.params.runtimeType);
  return {
    runtimeType,
    minecraftVersion,
    runtimeVersions: await serverJarProvider.listRuntimeVersions(runtimeType, minecraftVersion, { forceRefresh: request.query.refresh === "true" })
  };
});

app.post<{ Params: { runtimeType: string }; Body: { minecraftVersion?: string; runtimeVersion?: string; loaderVersion?: string; preferStable?: boolean; refresh?: boolean } }>("/api/runtime/:runtimeType/resolve", async (request) => {
  await requireRequestPermission(request, "servers.create");
  const minecraftVersion = request.body.minecraftVersion?.trim();
  if (!minecraftVersion) {
    throw new Error("minecraftVersion is required");
  }
  const runtimeType = parseServerRuntimeType(request.params.runtimeType);
  const runtimeProfile = await serverJarProvider.resolveServerJar({
    runtimeType,
    minecraftVersion,
    runtimeVersion: request.body.runtimeVersion?.trim() || request.body.loaderVersion?.trim() || "latest",
    preferStable: request.body.preferStable !== false,
    forceRefresh: request.body.refresh === true
  });
  return { runtimeProfile, warnings: [] };
});

// Legacy Fabric endpoints remain available while older web clients roll forward.
app.get<{ Querystring: { minecraftVersion?: string; refresh?: string } }>("/api/runtime/fabric/loader-versions", async (request) => {
  await requireVersionCatalogAccess(request);
  const minecraftVersion = request.query.minecraftVersion?.trim();
  if (!minecraftVersion) throw new Error("minecraftVersion is required");
  const versions = await serverJarProvider.listRuntimeVersions("fabric", minecraftVersion, { forceRefresh: request.query.refresh === "true" });
  return {
    minecraftVersion,
    loaderVersions: versions.map((version) => ({ ...version, loaderVersion: version.runtimeVersion }))
  };
});

}
