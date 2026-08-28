import type { ReleaseChannel } from "../types.js";
import { badRequest, forbidden } from "./errors.js";

/** Re-exported so existing `http/validation.js` importers keep working; defined in `http/errors.ts`. */
export { badRequest, forbidden };

export function requireStrictBoolean(value: unknown, fieldName: string) {
  if (typeof value !== "boolean") {
    badRequest(`${fieldName} must be a boolean`);
  }
  return value;
}

export function optionalStrictBoolean(value: unknown, fieldName: string, fallback: boolean) {
  return value === undefined ? fallback : requireStrictBoolean(value, fieldName);
}

export function optionalReleaseChannel(channel: unknown): ReleaseChannel {
  if (channel === undefined) return "release";
  if (channel === "release" || channel === "beta" || channel === "alpha") return channel;
  badRequest("Release channel must be one of release, beta, or alpha");
}

export function optionalCompatibilityFilter(value: unknown) {
  if (value === undefined) return undefined;
  if (value === "all" || value === "compatible" || value === "incompatible") return value;
  badRequest("Compatibility filter must be all, compatible, or incompatible");
}

function validateId(id: unknown, message: string) {
  if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id)) {
    badRequest(message);
  }
  return id;
}

export function validateServerId(id: unknown) {
  return validateId(id, "A valid server id is required");
}

export function validateScheduleId(id: unknown) {
  return validateId(id, "A valid schedule id is required");
}

export function validateOperationId(id: unknown) {
  return validateId(id, "A valid operation id is required");
}

export function validateNodeName(name: unknown) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value) return "Remote Node";
  if (value.length > 80 || /[\u0000-\u001f]/.test(value)) {
    badRequest("Node name must be 1-80 characters and cannot contain control characters");
  }
  return value;
}

export function optionalNodePanelUrl(panelUrl: unknown) {
  const value = typeof panelUrl === "string" ? panelUrl.trim() : "";
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    badRequest("Panel URL must be a valid http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    badRequest("Panel URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    badRequest("Panel URL cannot include embedded credentials");
  }
  return value;
}

export function optionalNodeDataMount(dataMount: unknown) {
  const value = typeof dataMount === "string" ? dataMount.trim() : "";
  if (!value) return undefined;
  if (value.length > 512 || /[\r\n\u0000]/.test(value)) {
    badRequest("Node data mount must be a single-line host path or host:container mount");
  }
  return value;
}

export function validateModrinthProjectId(projectId: unknown) {
  if (typeof projectId !== "string" || !/^[a-zA-Z0-9_-]{3,64}$/.test(projectId.trim())) {
    badRequest("A valid Modrinth project id is required");
  }
  return projectId.trim();
}

export function validateModrinthVersionId(versionId: unknown) {
  if (versionId === undefined || versionId === null || versionId === "") return undefined;
  if (typeof versionId !== "string" || !/^[a-zA-Z0-9_-]{3,64}$/.test(versionId.trim())) {
    badRequest("A valid Modrinth version id is required");
  }
  return versionId.trim();
}

export function validateRuntimeJarFilename(filename: unknown) {
  const value = typeof filename === "string" ? filename.trim() : "";
  if (!value || value.includes("/") || value.includes("\\") || value.includes("..") || !value.endsWith(".jar")) {
    badRequest("Server jar filename must be a local .jar filename");
  }
  return value;
}

export function validateDockerContainerName(name: unknown) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    badRequest("Docker container name contains invalid characters");
  }
  return value;
}

export function validateDockerImageName(image: unknown) {
  const value = typeof image === "string" ? image.trim() : "";
  if (!value || value.length > 255 || /\s/.test(value) || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value)) {
    badRequest("Docker image name contains invalid characters");
  }
  return value;
}

export function optionalBoundedInteger(value: unknown, fieldName: string, min: number, max: number) {
  if (value === undefined) return undefined;
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  if (!/^\d+$/.test(text)) {
    badRequest(`${fieldName} must be a whole number between ${min} and ${max}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    badRequest(`${fieldName} must be a whole number between ${min} and ${max}`);
  }
  return parsed;
}

export function validateRuntimeActionReason(reason: unknown) {
  if (typeof reason !== "string") badRequest("A reason is required to stop or restart a server");
  const value = reason.trim();
  if (!value) badRequest("A reason is required to stop or restart a server");
  if (value.length > 500) badRequest("The stop or restart reason cannot exceed 500 characters");
  if (/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    badRequest("The stop or restart reason contains unsupported control characters");
  }
  return value;
}

export function validateJavaArgs(args: unknown) {
  const value = typeof args === "string" ? args.trim() : "";
  if (!value) return "-Xms2G -Xmx4G";
  if (value.length > 512 || /[\r\n;&|`$<>\\]/.test(value)) {
    badRequest("Java arguments contain unsafe shell characters");
  }
  // Quotes are legitimate inside an argument, but the local runtime interpolates this string into
  // an `sh -lc` command. An unbalanced quote is not an injection — the chaining characters above are
  // already refused — but it makes the container exit on a shell parse error the operator cannot see.
  if (unbalancedQuote(value)) {
    badRequest("Java arguments contain an unterminated quote");
  }
  return value;
}

function unbalancedQuote(value: string) {
  let quote: "'" | "\"" | null = null;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === "\"") quote = character;
  }
  return quote !== null;
}

export function javaArgsToArgv(args: unknown) {
  const value = validateJavaArgs(args);
  const argv: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote) {
    badRequest("Java arguments contain an unterminated quote");
  }
  if (current) argv.push(current);
  return argv;
}
