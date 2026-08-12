import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";

const requestMock = vi.fn();

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  const actualDefault = (actual as { default?: typeof actual }).default ?? actual;
  return { ...actual, default: { ...actualDefault, request: requestMock }, request: requestMock };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => true };
});

describe("Docker client helpers", () => {
  afterEach(() => requestMock.mockReset());

  it("uses Docker error messages when present", async () => {
    const { dockerErrorMessage } = await import("./dockerClient.js");
    expect(dockerErrorMessage(JSON.stringify({ message: "container already exists" }), 409)).toBe("container already exists");
    expect(dockerErrorMessage("plain failure", 500)).toBe("plain failure");
    expect(dockerErrorMessage("", 404)).toBe("Docker API returned 404");
  });

  it("recognizes only missing Docker network IDs as recoverable", async () => {
    const { isMissingDockerNetworkError } = await import("./dockerClient.js");

    expect(isMissingDockerNetworkError(new Error("failed to set up container networking: network 9c7a2a2e5e03dca3d89e9bac010850b4658bcfde2e91fd46877cca771984972c not found"))).toBe(true);
    expect(isMissingDockerNetworkError("network deadbeefcafe not found")).toBe(true);
    expect(isMissingDockerNetworkError(new Error("network minecraft not found"))).toBe(false);
    expect(isMissingDockerNetworkError(new Error("No such container"))).toBe(false);
  });

  it("parses successful JSON bodies and rejects malformed responses", async () => {
    const { dockerJsonBody } = await import("./dockerClient.js");
    expect(dockerJsonBody<{ Id: string }>(JSON.stringify({ Id: "abc" }))).toEqual({ Id: "abc" });
    expect(dockerJsonBody<Record<string, never>>("")).toEqual({});
    expect(() => dockerJsonBody("{")).toThrow("Docker API returned malformed JSON");
  });

  it("probes the Docker API before reporting the endpoint as reachable", async () => {
    const fakeRequest = { on: vi.fn(), end: vi.fn(), write: vi.fn(), destroy: vi.fn() } as any;
    const handlers = new Map<string, (chunk?: Buffer) => void>();
    const response = {
      statusCode: 200,
      on: (event: string, handler: (chunk?: Buffer) => void) => { handlers.set(event, handler); return response; },
      destroy: vi.fn()
    };
    requestMock.mockImplementation((options: http.RequestOptions, onResponse: (value: unknown) => void) => {
      expect(options.path).toBe("/_ping");
      queueMicrotask(() => {
        onResponse(response);
        handlers.get("data")?.(Buffer.from("OK", "utf8"));
        handlers.get("end")?.();
      });
      return fakeRequest;
    });

    const { dockerReachable } = await import("./dockerClient.js");
    await expect(dockerReachable()).resolves.toBe(true);
  });

  it("does not treat an existing but unusable Docker path as reachable", async () => {
    let errorHandler: ((error: Error) => void) | undefined;
    const fakeRequest = {
      on: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === "error") errorHandler = handler;
        return fakeRequest;
      }),
      end: vi.fn(() => queueMicrotask(() => errorHandler?.(new Error("connect ENOTSOCK /tmp/docker.fake")))),
      write: vi.fn(),
      destroy: vi.fn()
    } as any;
    requestMock.mockReturnValue(fakeRequest);

    const { dockerReachable } = await import("./dockerClient.js");
    await expect(dockerReachable()).resolves.toBe(false);
  });

  it("uses Docker attach stdin instead of exec or /proc/1/fd/0", async () => {
    const writes: Buffer[] = [];
    const fakeRequest = {
      on: vi.fn(),
      setTimeout: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn()
    } as any;
    const fakeSocket = {
      setTimeout: vi.fn(),
      write: vi.fn((chunk: Buffer, callback: (error?: Error) => void) => {
        writes.push(Buffer.from(chunk));
        callback();
      }),
      destroy: vi.fn()
    };
    requestMock.mockImplementation((_options: http.RequestOptions, _response: unknown) => {
      queueMicrotask(() => {
        const upgradeHandler = fakeRequest.on.mock.calls.find(([event]: [string]) => event === "upgrade")?.[1];
        upgradeHandler?.({ statusCode: 200 }, fakeSocket);
      });
      return fakeRequest;
    });

    const { sendDockerContainerStdinLine } = await import("./dockerClient.js");
    await sendDockerContainerStdinLine("mc-server", " say test ");

    const options = requestMock.mock.calls[0][0] as http.RequestOptions;
    expect(options.method).toBe("POST");
    expect(options.path).toBe("/containers/mc-server/attach?stream=1&stdin=1&stdout=0&stderr=0");
    expect(String(options.path)).not.toContain("exec");
    expect(writes.map((chunk) => chunk.toString("utf8"))).toEqual(["say test\n"]);
  });

  it("rejects empty and multi-line commands before opening Docker attach", async () => {
    const { sendDockerContainerStdinLine } = await import("./dockerClient.js");

    await expect(sendDockerContainerStdinLine("mc-server", "   ")).rejects.toThrow("Command is required");
    await expect(sendDockerContainerStdinLine("mc-server", "say one\nsay two")).rejects.toThrow("Only one console command");
    expect(requestMock).not.toHaveBeenCalled();
  });

  // `tail=` bounds the number of log lines, not their length, so the response itself needs a ceiling.
  it("stops buffering a Docker response that exceeds its byte limit", async () => {
    const destroyed: string[] = [];
    const fakeRequest = { on: vi.fn(), end: vi.fn(), write: vi.fn(), destroy: vi.fn(() => destroyed.push("request")) } as any;
    const handlers = new Map<string, (chunk?: Buffer) => void>();
    const response = {
      statusCode: 200,
      on: (event: string, handler: (chunk?: Buffer) => void) => { handlers.set(event, handler); return response; },
      destroy: vi.fn(() => destroyed.push("response"))
    };
    requestMock.mockImplementation((_options: http.RequestOptions, onResponse: (value: unknown) => void) => {
      queueMicrotask(() => {
        onResponse(response);
        handlers.get("data")?.(Buffer.alloc(64, 0x41));
        handlers.get("data")?.(Buffer.alloc(64, 0x41));
      });
      return fakeRequest;
    });

    const { dockerBufferRequest } = await import("./dockerClient.js");
    await expect(dockerBufferRequest("GET", "/containers/mc/logs", 200, 15000, undefined, 100))
      .rejects.toThrow("Docker response exceeded the 100 byte limit");
    expect(destroyed).toContain("response");
  });

  it("returns a Docker response that stays under its byte limit", async () => {
    const fakeRequest = { on: vi.fn(), end: vi.fn(), write: vi.fn(), destroy: vi.fn() } as any;
    const handlers = new Map<string, (chunk?: Buffer) => void>();
    const response = {
      statusCode: 200,
      on: (event: string, handler: (chunk?: Buffer) => void) => { handlers.set(event, handler); return response; },
      destroy: vi.fn()
    };
    requestMock.mockImplementation((_options: http.RequestOptions, onResponse: (value: unknown) => void) => {
      queueMicrotask(() => {
        onResponse(response);
        handlers.get("data")?.(Buffer.from("log line", "utf8"));
        handlers.get("end")?.();
      });
      return fakeRequest;
    });

    const { dockerBufferRequest } = await import("./dockerClient.js");
    expect((await dockerBufferRequest("GET", "/containers/mc/logs", 200, 15000, undefined, 100)).toString("utf8")).toBe("log line");
  });
});
