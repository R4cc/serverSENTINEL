type ApiPayload = {
  error?: unknown;
  message?: unknown;
  code?: unknown;
  errorDetails?: unknown;
};

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: string;

  constructor(message: string, status: number, code?: string, details?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function payloadMessage(payload: ApiPayload, fallback: string) {
  return typeof payload.message === "string"
    ? payload.message
    : typeof payload.error === "string"
      ? payload.error
      : fallback;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const demoMode = window.localStorage.getItem("serversentinel-demo-mode") === "true";
  const headers = {
    "X-Requested-With": "XMLHttpRequest",
    ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(demoMode ? { "X-ServerSentinel-Demo-Mode": "true" } : {}),
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
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payloadMessage(payload, response.status === 401 ? "Authentication required. Sign in again to continue." : `Request failed with ${response.status}`);
    throw new ApiError(message, response.status, typeof payload.code === "string" ? payload.code : undefined, typeof payload.errorDetails === "string" ? payload.errorDetails : undefined);
  }
  return payload as T;
}
