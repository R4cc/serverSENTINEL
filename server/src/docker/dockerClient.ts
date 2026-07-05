import { existsSync } from "node:fs";
import http from "node:http";
import { config } from "../config.js";

type DockerMethod = "GET" | "POST" | "DELETE";

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
  options: { payload?: string; timeoutMs?: number } = {}
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
  expectedStatus: number | number[] = [200, 204, 304]
): Promise<T> {
  return dockerJsonBody<T>((await dockerSocketRequest(method, path, expectedStatus)).toString("utf8"));
}

export async function dockerBufferRequest(method: "GET" | "POST", path: string, expectedStatus: number | number[] = 200, timeoutMs = 15000) {
  return dockerSocketRequest(method, path, expectedStatus, { timeoutMs });
}

export async function dockerJsonRequest<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  expectedStatus: number | number[] = [200, 201, 204, 304]
): Promise<T> {
  const payload = JSON.stringify(body);
  return dockerJsonBody<T>((await dockerSocketRequest(method, path, expectedStatus, { payload })).toString("utf8"));
}

export async function dockerJsonBufferRequest(
  method: "POST",
  path: string,
  body: unknown,
  expectedStatus: number | number[] = 200
) {
  const payload = JSON.stringify(body);
  return dockerSocketRequest(method, path, expectedStatus, { payload });
}
