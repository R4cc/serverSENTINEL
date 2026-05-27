import { fetch } from "undici";

export async function fabricMeta<T>(path: string) {
  const response = await fetch(`https://meta.fabricmc.net${path}`, {
    headers: {
      "User-Agent": "ServerSentinel/0.3.0 (Fabric server creator)"
    }
  });
  if (!response.ok) {
    throw new Error(`Fabric metadata request failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function latestFabricVersion(kind: "loader" | "installer") {
  const versions = await fabricMeta<Array<{ version: string; stable: boolean }>>(`/v2/versions/${kind}`);
  const version = versions.find((candidate) => candidate.stable) ?? versions[0];
  if (!version) {
    throw new Error(`No Fabric ${kind} versions are available`);
  }
  return version.version;
}
