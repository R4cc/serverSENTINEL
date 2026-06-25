import type { FastifyReply } from "fastify";

export type PublicApiError = {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
};

export type HttpError = Error & {
  statusCode?: number;
  code?: string;
  details?: unknown;
};

export function apiErrorResponse(code: string, message: string, details: Record<string, unknown> = {}): PublicApiError {
  return {
    error: {
      code: toStableErrorCode(code),
      message,
      details
    }
  };
}

export function errorStatusCode(error: unknown, reply?: FastifyReply, expectedUserError = false) {
  if (error instanceof Error && "statusCode" in error && typeof (error as HttpError).statusCode === "number") {
    return (error as HttpError).statusCode!;
  }
  if (reply && reply.statusCode >= 400) return reply.statusCode;
  return expectedUserError ? 400 : 500;
}

export function publicApiError(error: unknown, statusCode: number): PublicApiError {
  if (statusCode >= 500) {
    return apiErrorResponse("INTERNAL_ERROR", "Internal server error");
  }
  const message = error instanceof Error ? error.message : "Request failed";
  return apiErrorResponse(stableErrorCode(error, statusCode), message, publicDetails(error));
}

export function stableErrorCode(error: unknown, statusCode: number) {
  const explicitCode = error instanceof Error && "code" in error && typeof (error as HttpError).code === "string"
    ? (error as HttpError).code
    : undefined;
  if (explicitCode) return toStableErrorCode(explicitCode);

  const message = error instanceof Error ? error.message : String(error);
  if (/invalid username or password/i.test(message)) return "INVALID_CREDENTIALS";
  if (/authentication required/i.test(message)) return "AUTHENTICATION_REQUIRED";
  if (/csrf/i.test(message)) return "CSRF_REJECTED";
  if (/permission|forbidden/i.test(message)) return "PERMISSION_DENIED";
  if (/demo mode/i.test(message)) return "DEMO_MODE_ACTIVE";
  if (/file changed|revision/i.test(message)) return "FILE_REVISION_CONFLICT";
  if (/lease/i.test(message)) return "FILE_EDIT_LEASE_LOST";
  if (/port .*already|already used.*port|query port/i.test(message)) return "PORT_CONFLICT";
  if (/container .*exists|container .*managed by ServerSentinel/i.test(message)) return "CONTAINER_CONFLICT";
  if (/already exists|duplicate/i.test(message)) return "CONFLICT";
  if (/not found|not available|could not be found|no managed server/i.test(message)) return "NOT_FOUND";
  if (/unsafe path|escapes|outside|path .*invalid|invalid relative path/i.test(message)) return "UNSAFE_PATH";
  if (/larger than|too large|size limit|between 1 byte/i.test(message)) return "PAYLOAD_TOO_LARGE";
  if (/binary files|binary file|unsupported file|not a text/i.test(message)) return "UNSUPPORTED_FILE_TYPE";
  if (/stop the server|must be running|not running|must be stopped/i.test(message)) return "SERVER_STATE_CONFLICT";
  if (/unsupported|not implemented|unavailable/i.test(message)) return "UNSUPPORTED_OPERATION";
  if (/required|invalid|must be|cannot|refusing|valid|malformed/i.test(message)) return "VALIDATION_ERROR";

  if (statusCode === 401) return "AUTHENTICATION_REQUIRED";
  if (statusCode === 403) return "PERMISSION_DENIED";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 409) return "CONFLICT";
  if (statusCode === 413) return "PAYLOAD_TOO_LARGE";
  if (statusCode === 429) return "RATE_LIMITED";
  return statusCode >= 400 && statusCode < 500 ? "VALIDATION_ERROR" : "INTERNAL_ERROR";
}

function publicDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error) || !("details" in error)) return {};
  const details = (error as HttpError).details;
  if (details === undefined || details === null) return {};
  if (typeof details === "string") {
    const trimmed = details.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return isRecord(parsed) ? parsed : { value: parsed };
    } catch {
      return { message: trimmed };
    }
  }
  return isRecord(details) ? details : { value: details };
}

function toStableErrorCode(code: string) {
  return code
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase() || "REQUEST_FAILED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
