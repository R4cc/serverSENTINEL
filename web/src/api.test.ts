import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { demoLocalStorageKey, readStoredDemoMode, writeStoredDemoMode } from "./app/appConfig";

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

  it("reads legacy and Fastify flat errors so older backends remain descriptive", async () => {
    mockWindow();
    mockFetch(Response.json({ message: "Old message", error: "Old error", code: "OLD_CODE" }, { status: 400 }));

    await expect(api("/api/test")).rejects.toMatchObject({
      status: 400,
      code: "OLD_CODE",
      message: "Old message"
    });
  });
});

describe("runtime-controlled demo mode", () => {
  it("leaves multipart content type generation to the browser", async () => {
    mockWindow();
    mockFetch(Response.json({ ok: true }));
    const body = new FormData();
    body.append("file", new Blob(["data"]), "test.txt");

    await api("/api/test", { method: "POST", body });

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      body,
      headers: expect.not.objectContaining({ "Content-Type": expect.anything() })
    }));
  });

  it("never sends a client-controlled demo header", async () => {
    const storage = mockWindow(fakeStorage({ [demoLocalStorageKey]: "true" }));
    mockFetch(Response.json({ ok: true }));

    await api("/api/test");

    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      headers: expect.not.objectContaining({ "X-serverSENTINEL-Demo-Mode": "true" })
    }));
  });

  it("allows the authenticated session flow to persist or clear runtime demo state", () => {
    const storage = fakeStorage({ [demoLocalStorageKey]: "true" });

    expect(readStoredDemoMode(storage, false)).toBe(false);
    expect(storage.removeItem).toHaveBeenCalledWith(demoLocalStorageKey);
    expect(readStoredDemoMode(fakeStorage({ [demoLocalStorageKey]: "true" }), true)).toBe(true);
  });

  it("keeps demo mode off when browser storage is unavailable", () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error("blocked"); }),
      setItem: vi.fn(() => { throw new Error("blocked"); }),
      removeItem: vi.fn(() => { throw new Error("blocked"); })
    } as unknown as Storage;

    expect(readStoredDemoMode(storage, true)).toBe(false);
    expect(readStoredDemoMode(storage, false)).toBe(false);
    expect(() => writeStoredDemoMode(true, storage, true)).not.toThrow();
    expect(() => writeStoredDemoMode(false, storage, false)).not.toThrow();
  });
});
