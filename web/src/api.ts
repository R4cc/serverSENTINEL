import { demoRequestHeaders } from "./app/appConfig";

type ApiPayload = {
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
};

export class ApiError extends Error {
  status: number;
  code?: string;
  details: unknown;

  constructor(message: string, status: number, code?: string, details: unknown = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function payloadError(payload: ApiPayload) {
  return payload && typeof payload.error === "object" && payload.error !== null ? payload.error : undefined;
}

export async function apiErrorFromResponse(response: Response, fallback?: string) {
  const payload = await response.json().catch(() => ({})) as ApiPayload;
  const error = payloadError(payload);
  const message = typeof error?.message === "string"
    ? error.message
    : fallback ?? (response.status === 401 ? "Authentication required. Sign in again to continue." : `Request failed with ${response.status}`);
  const code = typeof error?.code === "string" ? error.code : "REQUEST_FAILED";
  const details = error?.details ?? {};
  return new ApiError(message, response.status, code, details);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = {
    "X-Requested-With": "XMLHttpRequest",
    ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...demoRequestHeaders(),
    ...(init?.headers as Record<string, string> | undefined)
  };
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin"
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The request was cancelled.");
    }
    throw new Error("Could not reach the ServerSentinel backend. Check that the panel is running and try again.");
  }
  if (!response.ok) {
    throw await apiErrorFromResponse(response);
  }
  const payload = await response.json().catch(() => ({}));
  return payload as T;
}
