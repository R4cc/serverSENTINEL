type ApiPayload = {
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  } | string;
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

export const exportConflictEvent = "serversentinel:export-conflict";

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
  const multipartBody = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const headers = {
    "X-Requested-With": "XMLHttpRequest",
    ...(init?.body === undefined || multipartBody ? {} : { "Content-Type": "application/json" }),
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
    throw new Error("Could not reach the serverSENTINEL backend. Check that the panel is running and try again.");
  }
  if (!response.ok) {
    const error = await apiErrorFromResponse(response);
    if (
      typeof window !== "undefined"
      && ["EXPORT_IN_PROGRESS", "EXPORT_ALREADY_RUNNING", "SERVER_MUTATION_IN_PROGRESS"].includes(error.code ?? "")
    ) {
      window.dispatchEvent(new Event(exportConflictEvent));
    }
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  return payload as T;
}
