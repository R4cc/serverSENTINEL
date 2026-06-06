import type { FileEntry } from "../types";
import type { FilePreviewState } from "../app/uiState";
import { applyFormErrors, trimFormValue, validateDisplayName, validateDockerContainerName, validateDockerPorts, validateJavaArgs, validateRuntimeJarFilename, validateServerPort } from "./validation";

export function readCommandHistory() {
  try {
    const raw = window.localStorage.getItem("serversentinel-command-history");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string").slice(-50) : [];
  } catch {
    return [];
  }
}

export function errorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";
  if (!message) return fallback;
  if (/timeout|timed out/i.test(message)) {
    return "The request timed out. The server may still be busy.";
  }
  if (/docker|socket/i.test(message)) {
    return message.includes("not mounted")
      ? "Docker socket is not mounted. Runtime controls are unavailable."
      : message;
  }
  return message;
}

function firstValidationMessage(errors: Array<{ message: string }>) {
  return errors[0]?.message ?? "";
}

export function setValidationNotice(form: HTMLFormElement, errors: Array<{ field: string; message: string }>, setMessage: (message: string) => void) {
  if (!errors.length) return false;
  applyFormErrors(form, errors);
  setMessage(firstValidationMessage(errors));
  return true;
}

export function fileNameValidation(name: string) {
  const value = name.trim();
  if (!value) return "A file or folder name is required.";
  if (value === "." || value === ".." || value.length > 160) return "Use a normal file or folder name.";
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(value)) return "The name contains characters that are not safe for server files.";
  return "";
}

export function defaultDuplicateName(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    return `${name.slice(0, dot)} copy${name.slice(dot)}`;
  }
  return `${name} copy`;
}

export function modIconSource(iconUrl?: string | null) {
  if (!iconUrl) return "";
  if (iconUrl.startsWith("/")) return iconUrl;
  try {
    const url = new URL(iconUrl);
    if (url.protocol === "https:" && (url.hostname === "cdn.modrinth.com" || url.hostname.endsWith(".modrinth.com"))) {
      return `/api/modrinth/icon?url=${encodeURIComponent(url.toString())}`;
    }
  } catch {
    return "";
  }
  return "";
}

export function publicPathContains(containerPath: string, candidatePath: string) {
  const normalizedContainer = containerPath === "/" ? "/" : containerPath.replace(/\/+$/, "");
  if (normalizedContainer === "/") return candidatePath === "/" || candidatePath.startsWith("/");
  return candidatePath === normalizedContainer || candidatePath.startsWith(`${normalizedContainer}/`);
}

export function clearDeletedFileState(deletedEntries: FileEntry[], selectedPath: string, filePreviewPath: string, resetEditorState: () => void, setFilePreview: (state: FilePreviewState) => void) {
  const deletedPaths = deletedEntries.map((entry) => entry.path);
  if (selectedPath && deletedPaths.some((path) => publicPathContains(path, selectedPath))) {
    resetEditorState();
  }
  if (filePreviewPath && deletedPaths.some((path) => publicPathContains(path, filePreviewPath))) {
    setFilePreview({ path: "", loading: false, data: null, error: "" });
  }
}

export function serverConfigValidation(form: FormData, existingNames: string[], currentName?: string, options: { requireNode?: boolean; requireEula?: boolean; requireRuntime?: boolean } = {}) {
  const displayName = trimFormValue(form, "displayName");
  const errors: Array<{ field: string; message: string }> = [];
  const displayError = validateDisplayName(displayName);
  if (displayError) errors.push({ field: "displayName", message: displayError });
  if (displayName && displayName.toLowerCase() !== currentName?.toLowerCase() && existingNames.some((name) => name.toLowerCase() === displayName.toLowerCase())) {
    errors.push({ field: "displayName", message: "A managed server with this display name already exists." });
  }
  if (options.requireNode && !trimFormValue(form, "nodeId")) {
    errors.push({ field: "nodeId", message: "Choose a node that is online, compatible, and Docker-ready." });
  }
  if (options.requireEula && form.get("acceptEula") !== "on") {
    errors.push({ field: "acceptEula", message: "Accept the Minecraft EULA before creating this server." });
  }
  if (options.requireRuntime && !trimFormValue(form, "minecraftVersion")) {
    errors.push({ field: "minecraftVersion", message: "Choose a supported Minecraft version." });
  }
  if (options.requireRuntime && !trimFormValue(form, "loaderVersion")) {
    errors.push({ field: "loaderVersion", message: "Choose a Fabric loader version or keep the recommended option." });
  }
  const port = trimFormValue(form, "serverPort");
  if (port) {
    const portError = validateServerPort(port);
    if (portError) errors.push({ field: "serverPort", message: portError });
  }
  const queryPort = trimFormValue(form, "queryPort");
  if (queryPort) {
    const queryPortError = validateServerPort(queryPort);
    if (queryPortError) errors.push({ field: "queryPort", message: queryPortError.replace("Server port", "Query port").replace("server port", "Query port") });
  }
  if (port && queryPort && port === queryPort) {
    errors.push({ field: "queryPort", message: "Query port must be different from the server port." });
  }
  const jarError = validateRuntimeJarFilename(trimFormValue(form, "serverJar"));
  if (jarError) errors.push({ field: "serverJar", message: jarError });
  const containerError = validateDockerContainerName(trimFormValue(form, "dockerContainer"));
  if (containerError) errors.push({ field: "dockerContainer", message: containerError });
  const portsError = validateDockerPorts(trimFormValue(form, "dockerPorts"));
  if (portsError) errors.push({ field: "dockerPorts", message: portsError });
  const javaArgsError = validateJavaArgs(trimFormValue(form, "javaArgs"));
  if (javaArgsError) errors.push({ field: "javaArgs", message: javaArgsError });
  return errors;
}

export function hasPotentialEvent(text: string): boolean {
  const lowercase = text.toLowerCase();
  return (
    lowercase.includes("joined the game") ||
    lowercase.includes("left the game") ||
    lowercase.includes("lost connection:") ||
    lowercase.includes("disconnecting ") ||
    lowercase.includes("starting minecraft server") ||
    lowercase.includes("stopping server") ||
    lowercase.includes("stopping the server") ||
    lowercase.includes("all chunks are saved") ||
    /done \([^)]+\)! for help, type "help"/i.test(lowercase) ||
    /\b(disabled|disabling)\b.*\b(mod|\.jar)/i.test(lowercase) ||
    /\b(mod|\.jar).*?\b(disabled|disabling)\b/i.test(lowercase) ||
    /encountered an unexpected exception|this crash report has been saved to:|minecraft crash report|a crash report has been generated|the game crashed|server crashed/i.test(lowercase)
  );
}
