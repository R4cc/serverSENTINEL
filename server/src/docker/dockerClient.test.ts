import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";

const requestMock = vi.fn();

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, default: { ...actual.default, request: requestMock }, request: requestMock };
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

  it("parses successful JSON bodies and rejects malformed responses", async () => {
    const { dockerJsonBody } = await import("./dockerClient.js");
    expect(dockerJsonBody<{ Id: string }>(JSON.stringify({ Id: "abc" }))).toEqual({ Id: "abc" });
    expect(dockerJsonBody<Record<string, never>>("")).toEqual({});
    expect(() => dockerJsonBody("{")).toThrow("Docker API returned malformed JSON");
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
});
