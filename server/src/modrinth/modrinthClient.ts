import { fetch } from "undici";
import { modrinthApiKey } from "../storage/settingsStore.js";

export async function modrinthFetch(url: string) {
  const apiKey = await modrinthApiKey();
  if (!apiKey) {
    throw new Error("MODRINTH_API_KEY is not configured; Modrinth search and install are disabled");
  }
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ServerSentinel/0.2.0 (managed Fabric server panel)",
      Authorization: apiKey
    }
  });
  if (!response.ok) {
    throw new Error(`Modrinth request failed: ${response.status} ${response.statusText}`);
  }
  return response;
}
