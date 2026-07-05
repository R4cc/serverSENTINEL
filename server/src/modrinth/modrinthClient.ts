import { fetch } from "undici";

let apiKeyProvider = async () => process.env.MODRINTH_API_KEY || "";
const defaultModrinthTimeoutMs = 15_000;

export function configureModrinthApiKeyProvider(provider: () => Promise<string>) {
  apiKeyProvider = provider;
}

export function modrinthRequestHeaders(url: string, apiKey: string) {
  const headers: Record<string, string> = {
    "User-Agent": "serverSENTINEL/0.8.0 (managed Fabric server panel)"
  };
  if (apiKey && isModrinthApiUrl(url)) {
    headers.Authorization = apiKey;
  }
  return headers;
}

async function fetchWithTimeout(url: string, headers: Record<string, string>, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Modrinth request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function modrinthFetch(url: string, options: { timeoutMs?: number } = {}) {
  const apiKey = await apiKeyProvider();
  const headers = modrinthRequestHeaders(url, apiKey);
  const timeoutMs = options.timeoutMs ?? defaultModrinthTimeoutMs;
  const retryDelays = [0, 200, 600];
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt]) await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetchWithTimeout(url, headers, timeoutMs);
    } catch (error) {
      if (attempt === retryDelays.length - 1) throw error;
      continue;
    }
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

function isModrinthApiUrl(url: string) {
  try {
    return new URL(url).hostname === "api.modrinth.com";
  } catch {
    return false;
  }
}
