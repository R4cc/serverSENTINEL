import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDockerImage } from "./dockerImages.js";
import { dockerBufferRequest, dockerRequest } from "./dockerClient.js";

vi.mock("./dockerClient.js", () => ({ dockerAvailable: () => true, dockerBufferRequest: vi.fn(), dockerRequest: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(dockerRequest).mockRejectedValue(new Error("No such image"));
  vi.mocked(dockerBufferRequest).mockResolvedValue(Buffer.from('{"status":"Downloaded"}\n'));
});

describe("shared Docker image preparation", () => {
  it("reuses an installed image without contacting the registry", async () => {
    vi.mocked(dockerRequest).mockResolvedValue({});
    await ensureDockerImage("eclipse-temurin:21-jre");
    expect(dockerBufferRequest).not.toHaveBeenCalled();
  });
  it.each([
    ["registry.test:5000/minecraft:21", "registry.test:5000/minecraft", "21"],
    ["registry.test:5000/minecraft", "registry.test:5000/minecraft", "latest"],
    ["registry.test/minecraft@sha256:abc", "registry.test/minecraft", "sha256:abc"]
  ])("pulls the correct repository and tag for %s", async (image, fromImage, tag) => {
    await ensureDockerImage(image);
    expect(dockerBufferRequest).toHaveBeenCalledWith("POST", `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`, 200, 600_000);
  });
  it("surfaces registry failures embedded in a successful HTTP response", async () => {
    vi.mocked(dockerBufferRequest).mockResolvedValue(Buffer.from('{"status":"Pulling"}\n{"errorDetail":{"message":"unauthorized"}}\n'));
    await expect(ensureDockerImage("minecraft:21")).rejects.toThrow("Could not pull Docker image minecraft:21: unauthorized");
  });
});
