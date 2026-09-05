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
  it("rejects malformed successful bodies instead of treating them as loaded data", async () => {
    mockFetch(new Response("<html>proxy error</html>", { status: 200 }));
    await expect(api("/api/test")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("accepts an explicitly empty response", async () => {
    mockFetch(new Response(null, { status: 204 }));
    await expect(api("/api/test", { method: "DELETE" })).resolves.toEqual({});
  });

  it("sets a default deadline for reads without limiting long-running mutations", async () => {
    mockFetch(Response.json({ ok: true }));
    await api("/api/test");
    expect(globalThis.fetch).toHaveBeenLastCalledWith("/api/test", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    mockFetch(Response.json({ ok: true }));
    await api("/api/test", { method: "POST" });
    expect(globalThis.fetch).toHaveBeenLastCalledWith("/api/test", expect.objectContaining({ signal: undefined }));
  });

  it("reports timeouts while reading a successful response body", async () => {
    globalThis.fetch = vi.fn(async (_path: unknown, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    })) as unknown as typeof fetch;
    await expect(api("/api/test", { timeoutMs: 10 })).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  });
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

  it("fails a half-open request with a stable timeout code", async () => {
    globalThis.fetch = vi.fn((_path: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;

    await expect(api("/api/stalled", { timeoutMs: 10 })).rejects.toMatchObject({
      name: "ApiError",
      code: "REQUEST_TIMEOUT",
      status: 0
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
