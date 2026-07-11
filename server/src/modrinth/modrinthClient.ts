import { fetch } from "undici";
import { appUserAgentFor } from "../buildInfo.js";

let apiKeyProvider = async () => process.env.MODRINTH_API_KEY || "";
const defaultModrinthTimeoutMs = 15_000;
const defaultModrinthDeadlineMs = 35_000;
const defaultModrinthConcurrency = 8;
const maxRateLimitDelayMs = 60_000;
const maxTransientRetryDelayMs = 10_000;
let activeRequests = 0;
let rateLimitedUntil = 0;
const requestWaiters: Array<() => void> = [];
const inFlightGetRequests = new Map<string, Promise<Awaited<ReturnType<typeof fetch>>>>();

type PublicHttpError = Error & {
  statusCode?: number;
  code?: string;
  details?: unknown;
};

export function configureModrinthApiKeyProvider(provider: () => Promise<string>) {
  apiKeyProvider = provider;
}

export function modrinthRequestHeaders(url: string, apiKey: string) {
  const headers: Record<string, string> = {
    "User-Agent": appUserAgentFor("managed Fabric server panel")
  };
  const authorization = isModrinthApiUrl(url) ? modrinthAuthorizationHeader(apiKey) : "";
  if (authorization) {
    headers.Authorization = authorization;
  }
  return headers;
}

function modrinthAuthorizationHeader(apiKey: string) {
  const value = apiKey.trim();
  if (!value) return "";
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw modrinthPublicError("The configured Modrinth API key contains invalid characters. Re-enter it in Settings.", 400, "MODRINTH_API_KEY_INVALID");
  }
  return value;
}

function modrinthPublicError(message: string, statusCode = 424, code = "MODRINTH_REQUEST_FAILED", details?: unknown) {
  const error = new Error(message) as PublicHttpError;
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

async function fetchWithTimeout(url: string, headers: Record<string, string>, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw modrinthPublicError(`Modrinth request timed out after ${timeoutMs}ms`, 424, "MODRINTH_REQUEST_TIMED_OUT");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function acquireRequestSlot() {
  if (activeRequests < defaultModrinthConcurrency) {
    activeRequests += 1;
    return;
  }
  await new Promise<void>((resolve) => requestWaiters.push(resolve));
  activeRequests += 1;
}

function releaseRequestSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  requestWaiters.shift()?.();
}

function retryDelayMs(response: Awaited<ReturnType<typeof fetch>>, attempt: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maxRateLimitDelayMs);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), maxRateLimitDelayMs);
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const resetMs = reset > 10_000_000_000 ? reset - Date.now() : reset * 1000;
    return Math.min(Math.max(0, resetMs), maxRateLimitDelayMs);
  }
  return Math.min(250 * (2 ** attempt) + Math.floor(Math.random() * 150), maxTransientRetryDelayMs);
}

function transientRetryDelayMs(attempt: number) {
  return Math.min(250 * (2 ** attempt) + Math.floor(Math.random() * 150), maxTransientRetryDelayMs);
}

function observeRateLimitHeaders(response: Awaited<ReturnType<typeof fetch>>) {
  const remainingHeader = response.headers.get("x-ratelimit-remaining");
  const remaining = remainingHeader === null ? Number.NaN : Number(remainingHeader);
  if (Number.isFinite(remaining) && remaining <= 0) {
    rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + retryDelayMs(response, 0));
  }
}

async function waitWithinDeadline(delayMs: number, deadlineAt: number, code = "MODRINTH_REQUEST_TIMED_OUT") {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0 || delayMs >= remainingMs) {
    throw modrinthPublicError("Modrinth request exceeded its overall deadline", 424, code, { deadlineMs: defaultModrinthDeadlineMs });
  }
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForRateLimitCooldown(deadlineAt: number) {
  await waitWithinDeadline(Math.max(0, rateLimitedUntil - Date.now()), deadlineAt, "MODRINTH_RATE_LIMITED");
}

function upstreamDetails(response: Awaited<ReturnType<typeof fetch>>, attempt: number) {
  return {
    upstreamStatus: response.status,
    upstreamStatusText: response.statusText,
    attempt: attempt + 1,
    rateLimitLimit: response.headers.get("x-ratelimit-limit") ?? undefined,
    rateLimitRemaining: response.headers.get("x-ratelimit-remaining") ?? undefined,
    rateLimitReset: response.headers.get("x-ratelimit-reset") ?? undefined
  };
}

export type ModrinthFetchOptions = {
  timeoutMs?: number;
  deadlineMs?: number;
  method?: "GET" | "POST";
  json?: unknown;
};

async function executeModrinthFetch(url: string, options: ModrinthFetchOptions = {}) {
  const apiKey = await apiKeyProvider();
  let headers = modrinthRequestHeaders(url, apiKey);
  if (options.json !== undefined) headers["Content-Type"] = "application/json";
  const timeoutMs = options.timeoutMs ?? defaultModrinthTimeoutMs;
  const deadlineMs = options.deadlineMs ?? defaultModrinthDeadlineMs;
  const deadlineAt = Date.now() + deadlineMs;
  const retryAttempts = 3;
  let canRetryPublicGetWithoutAuthorization = (options.method ?? "GET") === "GET" && options.json === undefined && Boolean(headers.Authorization);
  for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
    let response: Awaited<ReturnType<typeof fetch>>;
    let acquiredSlot = false;
    try {
      await waitForRateLimitCooldown(deadlineAt);
      await acquireRequestSlot();
      acquiredSlot = true;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw modrinthPublicError("Modrinth request exceeded its overall deadline", 424, "MODRINTH_REQUEST_TIMED_OUT", { deadlineMs });
      const attemptTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingMs));
      if (options.method === "POST" || options.json !== undefined) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);
        timeout.unref?.();
        try {
          response = await fetch(url, { method: options.method ?? "POST", headers, body: options.json === undefined ? undefined : JSON.stringify(options.json), signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) throw modrinthPublicError(`Modrinth request timed out after ${attemptTimeoutMs}ms`, 424, "MODRINTH_REQUEST_TIMED_OUT");
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      } else {
        response = await fetchWithTimeout(url, headers, attemptTimeoutMs);
      }
    } catch (error) {
      if (attempt === retryAttempts - 1) {
        if (error instanceof Error && "statusCode" in error) throw error;
        throw modrinthPublicError(`Modrinth request failed: ${error instanceof Error ? error.message : String(error)}`, 424, "MODRINTH_REQUEST_FAILED", { attempt: attempt + 1 });
      }
      await waitWithinDeadline(transientRetryDelayMs(attempt), deadlineAt);
      continue;
    } finally {
      if (acquiredSlot) releaseRequestSlot();
    }
    if (response.ok) {
      observeRateLimitHeaders(response);
      return response;
    }
    if (canRetryPublicGetWithoutAuthorization && (response.status === 401 || response.status === 403)) {
      canRetryPublicGetWithoutAuthorization = false;
      headers = modrinthRequestHeaders(url, "");
      await response.arrayBuffer().catch(() => undefined);
      attempt -= 1;
      continue;
    }
    const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
    if (!retryable || attempt === retryAttempts - 1) {
      const code = response.status === 429 ? "MODRINTH_RATE_LIMITED" : "MODRINTH_REQUEST_FAILED";
      throw modrinthPublicError(`Modrinth request failed: ${response.status} ${response.statusText}`, 424, code, upstreamDetails(response, attempt));
    }
    const delayMs = response.status === 429 ? retryDelayMs(response, attempt) : transientRetryDelayMs(attempt);
    if (response.status === 429) rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + delayMs);
    await response.arrayBuffer().catch(() => undefined);
    await waitWithinDeadline(delayMs, deadlineAt, response.status === 429 ? "MODRINTH_RATE_LIMITED" : "MODRINTH_REQUEST_TIMED_OUT");
  }
  throw new Error("Modrinth request failed after retries");
}

export function resetModrinthClientStateForTests() {
  activeRequests = 0;
  rateLimitedUntil = 0;
  requestWaiters.splice(0);
  inFlightGetRequests.clear();
}

export async function modrinthFetch(url: string, options: ModrinthFetchOptions = {}) {
  const isGet = (options.method ?? "GET") === "GET" && options.json === undefined;
  if (!isGet) return executeModrinthFetch(url, options);
  const pending = inFlightGetRequests.get(url);
  if (pending) return (await pending).clone();
  const request = executeModrinthFetch(url, options).finally(() => inFlightGetRequests.delete(url));
  inFlightGetRequests.set(url, request);
  return (await request).clone();
}

function isModrinthApiUrl(url: string) {
  try {
    return new URL(url).hostname === "api.modrinth.com";
  } catch {
    return false;
  }
}
