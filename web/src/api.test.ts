import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockWindow() {
  globalThis.window = {
    localStorage: {
      getItem: () => null
    }
  } as unknown as Window & typeof globalThis;
}

function mockFetch(response: Response) {
  globalThis.fetch = vi.fn(async () => response) as unknown as typeof fetch;
}

describe("api error contract", () => {
  it("parses structured validation errors", async () => {
    mockWindow();
    mockFetch(Response.json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Display name is required",
        details: { field: "displayName" }
      }
    }, { status: 400 }));

    await expect(api("/api/servers", { method: "POST", body: "{}" })).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Display name is required",
      details: { field: "displayName" }
    } satisfies Partial<ApiError>);
  });

  it("handles auth, permission, conflict, not-found, and internal codes through the same shape", async () => {
    mockWindow();
    const cases = [
      [401, "AUTHENTICATION_REQUIRED"],
      [403, "PERMISSION_DENIED"],
      [404, "NOT_FOUND"],
      [409, "FILE_REVISION_CONFLICT"],
      [500, "INTERNAL_ERROR"]
    ] as const;

    for (const [status, code] of cases) {
      mockFetch(Response.json({ error: { code, message: code, details: {} } }, { status }));
      await expect(api("/api/test")).rejects.toMatchObject({ status, code, message: code });
    }
  });

  it("does not read legacy flat error fields", async () => {
    mockWindow();
    mockFetch(Response.json({ message: "Old message", error: "Old error", code: "OLD_CODE" }, { status: 400 }));

    await expect(api("/api/test")).rejects.toMatchObject({
      status: 400,
      code: "REQUEST_FAILED",
      message: "Request failed with 400"
    });
  });
});
