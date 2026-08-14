import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";

/**
 * A daemon restart - `apt upgrade docker-ce` being the case that started this - stops every running
 * container unless live-restore is on. serverSENTINEL cannot write the host's daemon configuration,
 * so the most it can do is read the flag and say so instead of letting the next upgrade be the way
 * an operator finds out.
 */

const dockerAvailableMock = vi.fn(() => true);
const dockerRequestMock = vi.fn();

vi.mock("./dockerClient.js", () => ({
  dockerAvailable: () => dockerAvailableMock(),
  dockerRequest: (...args: unknown[]) => dockerRequestMock(...args)
}));

describe("Docker daemon restart behaviour", () => {
  beforeEach(() => {
    dockerAvailableMock.mockReturnValue(true);
    dockerRequestMock.mockReset();
  });

  it("reports whether the daemon keeps containers alive across its own restart", async () => {
    const { dockerLiveRestoreEnabled } = await import("./dockerDaemon.js");

    dockerRequestMock.mockResolvedValue({ LiveRestoreEnabled: true });
    await expect(dockerLiveRestoreEnabled()).resolves.toBe(true);

    dockerRequestMock.mockResolvedValue({ LiveRestoreEnabled: false });
    await expect(dockerLiveRestoreEnabled()).resolves.toBe(false);
  });

  it("stays undecided rather than claiming containers are at risk when Docker cannot be asked", async () => {
    const { dockerLiveRestoreEnabled } = await import("./dockerDaemon.js");

    dockerRequestMock.mockRejectedValue(new Error("permission denied"));
    await expect(dockerLiveRestoreEnabled()).resolves.toBeUndefined();

    dockerAvailableMock.mockReturnValue(false);
    await expect(dockerLiveRestoreEnabled()).resolves.toBeUndefined();
    expect(dockerRequestMock).toHaveBeenCalledTimes(1);
  });

  it("waits out the stop grace period it asks Docker for", async () => {
    const { dockerStopQuery, dockerStopRequestTimeoutMs } = await import("./dockerDaemon.js");

    expect(dockerStopQuery()).toBe(`?t=${config.minecraftStopTimeoutSeconds}`);
    expect(dockerStopRequestTimeoutMs()).toBeGreaterThan(config.minecraftStopTimeoutSeconds * 1_000);
    expect(dockerStopRequestTimeoutMs(90)).toBeGreaterThan(90_000);
  });
});
