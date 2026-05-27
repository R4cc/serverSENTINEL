import { existsSync } from "node:fs";
import http from "node:http";
import { config } from "../config.js";

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

export async function dockerRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  expectedStatus: number | number[] = [200, 204, 304]
): Promise<T> {
  if (!dockerAvailable()) {
    throw new Error("Docker integration is not configured; mount /var/run/docker.sock to enable it");
  }

  const okStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  return new Promise<T>((resolveRequest, rejectRequest) => {
    const request = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (!okStatuses.includes(response.statusCode ?? 0)) {
            rejectRequest(new Error(dockerErrorMessage(body, response.statusCode)));
            return;
          }
          resolveRequest(body ? (JSON.parse(body) as T) : ({} as T));
        });
      }
    );
    request.on("error", rejectRequest);
    request.end();
  });
}

export async function dockerBufferRequest(method: "GET" | "POST", path: string, expectedStatus: number | number[] = 200) {
  if (!dockerAvailable()) {
    throw new Error("Docker integration is not configured; mount /var/run/docker.sock to enable it");
  }

  const okStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  return new Promise<Buffer>((resolveRequest, rejectRequest) => {
    const request = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          if (!okStatuses.includes(response.statusCode ?? 0)) {
            rejectRequest(new Error(dockerErrorMessage(body.toString("utf8"), response.statusCode)));
            return;
          }
          resolveRequest(body);
        });
      }
    );
    request.on("error", rejectRequest);
    request.end();
  });
}

export async function dockerJsonRequest<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  expectedStatus: number | number[] = [200, 201, 204, 304]
): Promise<T> {
  if (!dockerAvailable()) {
    throw new Error("Docker integration is not configured; mount /var/run/docker.sock to enable it");
  }

  const payload = JSON.stringify(body);
  const okStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  return new Promise<T>((resolveRequest, rejectRequest) => {
    const request = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (!okStatuses.includes(response.statusCode ?? 0)) {
            rejectRequest(new Error(dockerErrorMessage(responseBody, response.statusCode)));
            return;
          }
          resolveRequest(responseBody ? (JSON.parse(responseBody) as T) : ({} as T));
        });
      }
    );
    request.on("error", rejectRequest);
    request.write(payload);
    request.end();
  });
}

export async function dockerJsonBufferRequest(
  method: "POST",
  path: string,
  body: unknown,
  expectedStatus: number | number[] = 200
) {
  if (!dockerAvailable()) {
    throw new Error("Docker integration is not configured; mount /var/run/docker.sock to enable it");
  }

  const payload = JSON.stringify(body);
  const okStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  return new Promise<Buffer>((resolveRequest, rejectRequest) => {
    const request = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const bodyBuffer = Buffer.concat(chunks);
          if (!okStatuses.includes(response.statusCode ?? 0)) {
            rejectRequest(new Error(dockerErrorMessage(bodyBuffer.toString("utf8"), response.statusCode)));
            return;
          }
          resolveRequest(bodyBuffer);
        });
      }
    );
    request.on("error", rejectRequest);
    request.write(payload);
    request.end();
  });
}
