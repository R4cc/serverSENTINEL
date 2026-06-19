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
  const retryDelays = [0, 200, 600];
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt]) await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    const response = await fetch(url, { headers });
    if (response.ok) return response;
    const retryable = response.status >= 500 && response.status < 600;
    if (!retryable || attempt === retryDelays.length - 1) {
      throw new Error(`Modrinth request failed: ${response.status} ${response.statusText}`);
    }
    await response.arrayBuffer().catch(() => undefined);
  }
  throw new Error("Modrinth request failed after retries");
}
