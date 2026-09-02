import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedServer } from "../types.js";

const mocks = vi.hoisted(() => ({
  platform: "linux",
  managed: true,
  inspect: vi.fn(),
  readFile: vi.fn(),
  bufferRequest: vi.fn(),
  jsonRequest: vi.fn(),
  request: vi.fn()
}));

vi.mock("node:os", () => ({ platform: () => mocks.platform }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("../runtime/local/dockerContainers.js", () => ({ inspectDockerContainer: mocks.inspect }));
vi.mock("../runtime/containerLabels.js", () => ({ isManagedContainerFor: () => mocks.managed }));
vi.mock("../docker/dockerClient.js", () => ({
  dockerBufferBodyRequest: mocks.bufferRequest,
  dockerJsonRequest: mocks.jsonRequest,
  dockerRequest: mocks.request
}));

import { dockerExecStdout, executableTarArchive, readDockerPlayerConnections } from "./dockerPlayerConnections.js";

function server(id = "server-1") {
  return {
    id,
    dockerContainer: `serversentinel-${id}`,
    dockerPorts: "25575:25565/tcp",
    managedPorts: [{ type: "minecraft", protocol: "tcp", externalPort: 25575, internalPort: 25565 }]
  } as ManagedServer;
}

function frame(stream: 1 | 2, value: string) {
  const body = Buffer.from(value);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform = "linux";
  mocks.managed = true;
  mocks.readFile.mockResolvedValue(Buffer.from("native-probe"));
  mocks.inspect.mockResolvedValue({ Id: `container-${Math.random()}`, State: { Running: true }, Config: { Labels: {} } });
  mocks.jsonRequest.mockResolvedValue({ Id: "exec-1" });
  mocks.bufferRequest.mockImplementation(async (method: string) => method === "POST"
    ? frame(1, '{"connections":[{"remoteAddress":"203.0.113.5","remotePort":50123,"rttUs":42000}]}')
    : Buffer.alloc(0));
  mocks.request.mockResolvedValue({ Running: false, ExitCode: 0 });
});

describe("Docker player connection probe", () => {
  it("creates an executable single-file tar archive with a valid checksum", () => {
    const archive = executableTarArchive("probe", Buffer.from("hello"));
    expect(archive.subarray(0, 5).toString()).toBe("probe");
    expect(archive.subarray(100, 108).toString()).toContain("0000755");
    expect(archive.subarray(257, 263).toString()).toBe("ustar\0");
    const recorded = Number.parseInt(archive.subarray(148, 154).toString(), 8);
    const header = Buffer.from(archive.subarray(0, 512));
    header.fill(0x20, 148, 156);
    expect(header.reduce((sum, byte) => sum + byte, 0)).toBe(recorded);
    expect(archive.subarray(512, 517).toString()).toBe("hello");
  });

  it("extracts stdout while excluding stderr and rejects truncated multiplexed output", () => {
    expect(dockerExecStdout(Buffer.concat([frame(2, "private failure"), frame(1, "safe json")]))).toBe("safe json");
    expect(() => dockerExecStdout(Buffer.from([1, 0, 0]))).toThrow(/truncated stream frame/i);
    expect(() => dockerExecStdout(Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 9]), Buffer.from("short")]))).toThrow(/truncated stream payload/i);
  });

  it("copies the probe once, directly execs it with the internal port, and returns bounded data", async () => {
    const instance = server("direct-exec");
    mocks.inspect.mockResolvedValue({ Id: "container-direct", State: { Running: true }, Config: { Labels: {} } });

    await expect(readDockerPlayerConnections(instance)).resolves.toMatchObject({
      status: "available",
      instanceId: "container-direct",
      connections: [{ remoteAddress: "203.0.113.5", remotePort: 50123, rttUs: 42000 }]
    });
    await readDockerPlayerConnections(instance);

    const archiveCalls = mocks.bufferRequest.mock.calls.filter(([method]) => method === "PUT");
    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0][1]).toContain("/containers/container-direct/archive?path=%2Ftmp");
    expect(mocks.jsonRequest).toHaveBeenCalledWith("POST", "/containers/container-direct/exec", expect.objectContaining({
      Tty: false,
      Cmd: ["/tmp/.serversentinel-tcp-rtt", "--port", "25565"]
    }), 201);
    expect(mocks.bufferRequest).toHaveBeenCalledWith(
      "POST",
      "/exec/exec-1/start",
      JSON.stringify({ Detach: false, Tty: false }),
      200,
      expect.objectContaining({ timeoutMs: 5_000, maxBytes: 256 * 1024 })
    );
    expect(mocks.request).toHaveBeenCalledWith("GET", "/exec/exec-1/json", 200, undefined, 2_000);
  });

  it("reinstalls once when direct execution fails, then succeeds", async () => {
    mocks.inspect.mockResolvedValue({ Id: "container-retry", State: { Running: true }, Config: { Labels: {} } });
    mocks.jsonRequest.mockRejectedValueOnce(new Error("executable missing")).mockResolvedValueOnce({ Id: "exec-2" });

    await expect(readDockerPlayerConnections(server("retry"))).resolves.toMatchObject({ status: "available" });
    expect(mocks.bufferRequest.mock.calls.filter(([method]) => method === "PUT")).toHaveLength(2);
    expect(mocks.jsonRequest).toHaveBeenCalledTimes(2);
  });

  it("returns safe unsupported, idle, ownership, and malformed-output states", async () => {
    mocks.platform = "win32";
    await expect(readDockerPlayerConnections(server("windows"))).resolves.toMatchObject({ status: "unsupported", connections: [] });
    expect(mocks.inspect).not.toHaveBeenCalled();

    mocks.platform = "linux";
    mocks.inspect.mockResolvedValueOnce({ Id: "container-idle", State: { Running: false }, Config: { Labels: {} } });
    await expect(readDockerPlayerConnections(server("idle"))).resolves.toMatchObject({ status: "idle", connections: [] });

    mocks.inspect.mockResolvedValueOnce({ Id: "container-foreign", State: { Running: true }, Config: { Labels: {} } });
    mocks.managed = false;
    await expect(readDockerPlayerConnections(server("foreign"))).resolves.toMatchObject({ status: "unavailable", connections: [] });

    mocks.managed = true;
    mocks.inspect.mockResolvedValue({ Id: "container-malformed", State: { Running: true }, Config: { Labels: {} } });
    mocks.bufferRequest.mockImplementation(async (method: string) => method === "POST" ? frame(1, "not json") : Buffer.alloc(0));
    const result = await readDockerPlayerConnections(server("malformed"));
    expect(result).toMatchObject({ status: "unavailable", connections: [] });
    expect(JSON.stringify(result)).not.toContain("not json");
  });
});
