import type { FastifyRequest } from "fastify";
import { AsyncLocalStorage } from "node:async_hooks";
import { services } from "./appServices.js";

export type LogFields = Record<string, unknown>;

type RequestLogContext = {
  requestId: string;
  clientIp: string;
  actorUserId?: string;
  actorUsername?: string;
  actorRolePreset?: string;
};

type LogActor = {
  id: string;
  username: string;
  rolePreset?: string;
};

const requestLogContext = new AsyncLocalStorage<RequestLogContext>();

function contextualFields(fields: LogFields): LogFields {
  const context = requestLogContext.getStore();
  return context ? { ...context, ...fields } : fields;
}

export function runWithRequestLogContext<T>(context: Pick<RequestLogContext, "requestId" | "clientIp">, callback: () => T): T {
  return requestLogContext.run(context, callback);
}

export function setRequestLogActor(actor: LogActor | null | undefined) {
  const context = requestLogContext.getStore();
  if (!context || !actor) return;
  context.actorUserId = actor.id;
  context.actorUsername = actor.username;
  context.actorRolePreset = actor.rolePreset;
}

export function logDebug(fields: LogFields, message: string) {
  services.appLogger?.debug(contextualFields(fields), message);
}

export function logInfo(fields: LogFields, message: string) {
  services.appLogger?.info(contextualFields(fields), message);
}

export function logWarn(fields: LogFields, message: string) {
  services.appLogger?.warn(contextualFields(fields), message);
}

export function logError(fields: LogFields, message: string) {
  services.appLogger?.error(contextualFields(fields), message);
}

export function errorLogFields(error: unknown, fallbackStatusCode?: number): LogFields {
  if (!(error instanceof Error)) {
    return { errorMessage: String(error) };
  }
  const statusCode = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : fallbackStatusCode;
  const details = "details" in error && typeof error.details === "string" ? error.details : undefined;
  const structuredDetails = "details" in error && error.details && typeof error.details === "object"
    ? error.details as Record<string, unknown>
    : undefined;
  return {
    errorName: error.name,
    errorMessage: error.message,
    errorDetails: details,
    upstreamStatus: typeof structuredDetails?.upstreamStatus === "number" ? structuredDetails.upstreamStatus : undefined,
    upstreamAttempt: typeof structuredDetails?.attempt === "number" ? structuredDetails.attempt : undefined,
    rateLimitRemaining: typeof structuredDetails?.rateLimitRemaining === "string" ? structuredDetails.rateLimitRemaining : undefined,
    rateLimitReset: typeof structuredDetails?.rateLimitReset === "string" ? structuredDetails.rateLimitReset : undefined,
    statusCode,
    stack: statusCode && statusCode < 500 ? undefined : error.stack
  };
}

export function detailedErrorMessage(error: unknown) {
  if (error instanceof Error && "details" in error && typeof error.details === "string" && error.details.trim()) {
    return error.details.trim();
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  }
  return String(error);
}

export function detailedError(error: Error, details: string) {
  (error as Error & { details?: string }).details = details;
  return error;
}

export function errorCategory(error: unknown, statusCode?: number) {
  const message = error instanceof Error ? error.message : String(error);
  if (statusCode && statusCode < 500) return "validation";
  if (/docker|container|socket|exec/i.test(message)) return "docker_api";
  if (/modrinth|fabric|download|fetch|api/i.test(message)) return "external_api";
  return "internal";
}

export function isExpectedUserError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /required|not found|invalid|refusing|stop the server|must be|cannot be|larger than|binary files|not configured|unavailable|incompatible|already exists|duplicate/i.test(message);
}

export function logOperationFailure(fields: LogFields, message: string, error: unknown) {
  const expected = isExpectedUserError(error);
  const payload = { ...fields, ...errorLogFields(error, expected ? 400 : undefined) };
  if (expected) {
    logWarn(payload, message);
    return;
  }
  logError(payload, message);
}

export function routeLogFields(request: FastifyRequest, statusCode?: number): LogFields {
  return {
    method: request.method,
    route: request.routeOptions.url ?? request.raw.url?.split("?")[0] ?? request.url.split("?")[0],
    statusCode
  };
}

export function durationSince(startedAt: number) {
  return Date.now() - startedAt;
}
