import { existsSync } from "node:fs";
import http from "node:http";
import { config } from "../config.js";

type DockerMethod = "GET" | "POST" | "DELETE";

type DockerStdinOptions = { timeoutMs?: number };

export function dockerAvailable() {
  return existsSync(config.dockerSocket);
}

export function dockerErrorMessage(body: string, statusCode?: number) {
  if (body) {
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) {
        return parsed.message;
      }
    } catch {
      return body;
    }
  }
  return `Docker API returned ${statusCode ?? "an error"}`;
}

export function isMissingDockerNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /\bnetwork\s+[a-f0-9]{12,64}\s+not found\b/i.test(message);
}

export function dockerJsonBody<T>(body: string): T {
  if (!body) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error("Docker API returned malformed JSON");
  }
}

function okStatuses(expectedStatus: number | number[]) {
  return Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
}

async function dockerSocketRequest(
  method: DockerMethod,
  path: string,
  expectedStatus: number | number[],
  options: { payload?: string; timeoutMs?: number; signal?: AbortSignal } = {}
) {
  if (!dockerAvailable()) {
    throw new Error("Docker integration is not configured; mount /var/run/docker.sock to enable it");
  }

  const payload = options.payload;
  const statuses = okStatuses(expectedStatus);
  return new Promise<Buffer>((resolveRequest, rejectRequest) => {
    const request = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method,
        timeout: options.timeoutMs ?? 15000,
        signal: options.signal,
        headers: payload === undefined ? undefined : {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          if (!statuses.includes(response.statusCode ?? 0)) {
            rejectRequest(new Error(dockerErrorMessage(body.toString("utf8"), response.statusCode)));
            return;
          }
          resolveRequest(body);
        });
      }
    );
    request.on("timeout", () => {
      request.destroy(new Error("Docker socket request timed out"));
    });
    request.on("error", rejectRequest);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

export async function dockerRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  expectedStatus: number | number[] = [200, 204, 304],
  signal?: AbortSignal
): Promise<T> {
  return dockerJsonBody<T>((await dockerSocketRequest(method, path, expectedStatus, { signal })).toString("utf8"));
}

export async function dockerBufferRequest(method: "GET" | "POST", path: string, expectedStatus: number | number[] = 200, timeoutMs = 15000, signal?: AbortSignal) {
  return dockerSocketRequest(method, path, expectedStatus, { timeoutMs, signal });
}

export async function dockerJsonRequest<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  expectedStatus: number | number[] = [200, 201, 204, 304],
  signal?: AbortSignal
): Promise<T> {
  const payload = JSON.stringify(body);
  return dockerJsonBody<T>((await dockerSocketRequest(method, path, expectedStatus, { payload, signal })).toString("utf8"));
}

export async function sendDockerContainerStdinLine(containerName: string, line: string, options: DockerStdinOptions = {}) {
  if (!dockerAvailable()) {
    throw new Error("Docker integration is not configured; mount /var/run/docker.sock to enable it");
  }
  if (!containerName.trim()) throw new Error("Docker container name is required");
  if (!line.trim()) throw new Error("Command is required");
  if (/[\r\n]/.test(line)) throw new Error("Only one console command can be sent at a time");

  const payload = Buffer.from(`${line.trim()}\n`, "utf8");
  const path = `/containers/${encodeURIComponent(containerName)}/attach?stream=1&stdin=1&stdout=0&stderr=0`;
  const timeoutMs = options.timeoutMs ?? 5000;

  await new Promise<void>((resolveAttach, rejectAttach) => {
    let settled = false;
    let request: http.ClientRequest;
    let responseSocket: import("node:net").Socket | undefined;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      responseSocket?.destroy();
      request.destroy();
      if (error) rejectAttach(error);
      else resolveAttach();
    };
    let timer: NodeJS.Timeout;
    request = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method: "POST",
        headers: { Connection: "Upgrade", Upgrade: "tcp" }
      },
      (response) => {
        response.resume();
        if (response.statusCode !== 200) {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => settle(new Error(dockerErrorMessage(Buffer.concat(chunks).toString("utf8"), response.statusCode))));
          return;
        }
        responseSocket = response.socket;
        responseSocket.setTimeout(timeoutMs, () => settle(new Error("Docker attach stdin write timed out")));
        responseSocket.write(payload, (error) => {
          if (error) settle(error);
          else settle();
        });
      }
    );
    request.on("upgrade", (_response, socket) => {
      responseSocket = socket;
      socket.setTimeout(timeoutMs, () => settle(new Error("Docker attach stdin write timed out")));
      socket.write(payload, (error) => {
        if (error) settle(error);
        else settle();
      });
    });
    request.on("timeout", () => settle(new Error("Docker attach stdin write timed out")));
    request.on("error", settle);
    request.setTimeout(timeoutMs);
    timer = setTimeout(() => settle(new Error("Docker attach stdin write timed out")), timeoutMs);
    request.end();
  });
}
