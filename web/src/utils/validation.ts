import { maxServerPort, minServerPort } from "./format";

export type FieldValidationError = {
  field: string;
  message: string;
};

export function trimFormValue(form: FormData, field: string) {
  return String(form.get(field) ?? "").trim();
}

export function validateUsername(value: string): string | null {
  const username = value.trim();
  if (!username) return "Username is required.";
  if (username.length < 3 || username.length > 32) return "Username must be 3-32 characters.";
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return "Username can use letters, numbers, dots, dashes, and underscores.";
  return null;
}

export function validatePassword(value: string, required = true): string | null {
  if (!value && !required) return null;
  if (!value) return "Password is required.";
  if (value.length < 8) return "Password must be at least 8 characters.";
  return null;
}

export function validateDisplayName(value: string): string | null {
  const name = value.trim();
  if (!name) return "Display name is required.";
  if (name.length > 80) return "Display name must be 80 characters or fewer.";
  if (!/[a-zA-Z0-9]/.test(name)) return "Display name must include at least one letter or number.";
  return null;
}

export function validateServerPort(value: string): string | null {
  if (!/^\d+$/.test(value.trim())) return `Server port must be a number from ${minServerPort} to ${maxServerPort}.`;
  const port = Number(value);
  if (port < minServerPort || port > maxServerPort) return `Server port must be between ${minServerPort} and ${maxServerPort}.`;
  return null;
}

export function validateRuntimeJarFilename(value: string): string | null {
  const filename = value.trim();
  if (!filename) return null;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return "Server jar must be a local filename, not a path.";
  if (!filename.endsWith(".jar")) return "Server jar filename must end with .jar.";
  return null;
}

export function validateDockerContainerName(value: string): string | null {
  const name = value.trim();
  if (!name) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) return "Docker container name can use letters, numbers, dots, dashes, and underscores.";
  return null;
}

export function validateDockerPorts(value: string): string | null {
  const ports = value.trim();
  if (!ports) return null;
  for (const rawPort of ports.split(",")) {
    const port = rawPort.trim();
    if (!port) continue;
    const pieces = port.split(":");
    if (pieces.length > 2) return `Invalid port binding: ${port}.`;
    const [hostPort, containerPortWithProtocol] = pieces.length === 2 ? pieces : [pieces[0], pieces[0]];
    const [containerPort, protocol = "tcp"] = containerPortWithProtocol.split("/", 2);
    if (!isValidPort(hostPort) || !isValidPort(containerPort) || !["tcp", "udp"].includes(protocol)) {
      return `Invalid port binding: ${port}. Use formats like 25565 or 25565:25565/tcp.`;
    }
  }
  return null;
}

export function validateJavaArgs(value: string): string | null {
  const args = value.trim();
  if (!args) return null;
  if (args.length > 512) return "Java arguments must be 512 characters or fewer.";
  if (/[\r\n;&|`$<>\\]/.test(args)) return "Java arguments cannot contain shell metacharacters.";
  return null;
}

export function validateCronExpression(value: string): string | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) return "Cron schedule must use five fields: minute hour day month weekday.";
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  for (let index = 0; index < parts.length; index += 1) {
    if (!isValidCronField(parts[index], ranges[index][0], ranges[index][1])) {
      return "Cron schedule contains an invalid field.";
    }
  }
  return null;
}

export function validateCommandList(commands: string[]): string | null {
  const clean = commands.map((command) => command.trim()).filter(Boolean);
  if (!clean.length) return "At least one command is required.";
  if (clean.some((command) => /[\r\n]/.test(command))) return "Commands must be one line each.";
  return null;
}

export function validateSafePath(value: string): string | null {
  const path = value.trim();
  if (!path) return "Path is required.";
  if (path.includes("\0")) return "Path contains invalid characters.";
  if (path.includes("..") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\")) return "Path must stay inside the managed server directory.";
  return null;
}

export function validateJarFilename(value: string): string | null {
  const filename = value.trim();
  if (!filename.endsWith(".jar")) return "Only .jar mod files are supported.";
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return "Mod filename must not contain a path.";
  return null;
}

export function applyFormErrors(form: HTMLFormElement, errors: FieldValidationError[]) {
  for (const element of Array.from(form.elements)) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      element.setCustomValidity("");
    }
  }
  for (const error of errors) {
    const field = form.elements.namedItem(error.field);
    const element = Array.isArray(field) ? field[0] : field;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      element.setCustomValidity(error.message);
      element.addEventListener("input", () => element.setCustomValidity(""), { once: true });
      element.addEventListener("change", () => element.setCustomValidity(""), { once: true });
    }
  }
  if (errors.length) {
    form.reportValidity();
  }
}

function isValidPort(value: string) {
  if (!/^\d+$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

function isValidCronField(field: string, min: number, max: number) {
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) return false;
    const [rangePart, stepPart] = part.split("/", 2);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return false;
    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [rawStart, rawEnd] = rangePart.split("-", 2).map(Number);
        if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return false;
        start = rawStart;
        end = rawEnd;
      } else {
        const exact = Number(rangePart);
        if (!Number.isInteger(exact)) return false;
        start = exact;
        end = exact;
      }
    }
    if (start < min || end > max || start > end) return false;
  }
  return true;
}
