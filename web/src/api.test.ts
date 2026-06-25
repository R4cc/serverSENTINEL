import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { demoLocalStorageKey, demoRequestHeaders, readStoredDemoMode } from "./app/appConfig";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() {
      return values.size;
    }
  } as unknown as Storage;
}

function mockWindow(storage = fakeStorage()) {
  globalThis.window = {
    localStorage: storage
  } as unknown as Window & typeof globalThis;
  return storage;
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

describe("api demo mode headers", () => {
  it("does not send demo headers and clears stale demo state when demo is disabled", async () => {
    const storage = mockWindow(fakeStorage({ [demoLocalStorageKey]: "true" }));
    mockFetch(Response.json({ ok: true }));

    await api("/api/test");

    expect(storage.removeItem).toHaveBeenCalledWith(demoLocalStorageKey);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      headers: expect.not.objectContaining({ "X-ServerSentinel-Demo-Mode": "true" })
    }));
  });

  it("returns the demo header only when the build flag is enabled and stored demo state is active", () => {
    const storage = fakeStorage({ [demoLocalStorageKey]: "true" });

    expect(readStoredDemoMode(storage, false)).toBe(false);
    expect(storage.removeItem).toHaveBeenCalledWith(demoLocalStorageKey);
    expect(demoRequestHeaders(fakeStorage({ [demoLocalStorageKey]: "true" }), true)).toEqual({
      "X-ServerSentinel-Demo-Mode": "true"
    });
    expect(demoRequestHeaders(fakeStorage({ [demoLocalStorageKey]: "false" }), true)).toEqual({});
  });
});
