import { fetch } from "undici";
import { modrinthApiKey } from "../storage/settingsStore.js";

export async function modrinthFetch(url: string) {
  const apiKey = await modrinthApiKey();
  const headers: Record<string, string> = {
    "User-Agent": "ServerSentinel/0.7.0 (managed Fabric server panel)"
  };
  if (apiKey) {
    headers.Authorization = apiKey;
  }
  const response = await fetch(url, {
    headers
  });
  if (!response.ok) {
    throw new Error(`Modrinth request failed: ${response.status} ${response.statusText}`);
  }
  return response;
}
