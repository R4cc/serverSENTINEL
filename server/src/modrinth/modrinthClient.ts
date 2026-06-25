import { fetch } from "undici";

let apiKeyProvider = async () => process.env.MODRINTH_API_KEY || "";

export function configureModrinthApiKeyProvider(provider: () => Promise<string>) {
  apiKeyProvider = provider;
}

export async function modrinthFetch(url: string) {
  const apiKey = await apiKeyProvider();
  const headers: Record<string, string> = {
    "User-Agent": "ServerSentinel/0.8.0 (managed Fabric server panel)"
  };
  if (apiKey) {
    headers.Authorization = apiKey;
  }
  const retryDelays = [0, 200, 600];
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt]) await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    const response = await fetch(url, { headers });
    if (response.ok) return response;
    const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
    if (!retryable || attempt === retryDelays.length - 1) {
      throw new Error(`Modrinth request failed: ${response.status} ${response.statusText}`);
    }
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    await response.arrayBuffer().catch(() => undefined);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfterSeconds * 1000, 2000)));
    }
  }
  throw new Error("Modrinth request failed after retries");
}
