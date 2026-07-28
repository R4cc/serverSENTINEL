import { describe, expect, it } from "vitest";
import {
  configHashLabel,
  containerConfigHash,
  isManagedContainer,
  isManagedContainerFor,
  legacyServerIdLabel,
  managedContainerLabels,
  managedLabel,
  serverIdLabel
} from "./containerLabels.js";

const serverId = "00000000-0000-4000-8000-000000000001";

describe("managed container labels", () => {
  it("stamps the canonical keys", () => {
    expect(managedContainerLabels(serverId, "hash-1")).toEqual({
      [managedLabel]: "true",
      [serverIdLabel]: serverId,
      [configHashLabel]: "hash-1"
    });
  });

  it("recognizes a container it just labelled", () => {
    expect(isManagedContainerFor(managedContainerLabels(serverId, "hash-1"), serverId)).toBe(true);
  });

  it("still recognizes containers created before the label keys were unified", () => {
    const legacy = { [managedLabel]: "true", [legacyServerIdLabel]: serverId, [configHashLabel]: "hash-1" };
    expect(isManagedContainerFor(legacy, serverId)).toBe(true);
  });

  it("rejects a managed container owned by a different server", () => {
    const other = managedContainerLabels("00000000-0000-4000-8000-000000000002", "hash-1");
    expect(isManagedContainerFor(other, serverId)).toBe(false);
  });

  it("rejects unmanaged containers, including ones carrying only a server id", () => {
    expect(isManagedContainer(undefined)).toBe(false);
    expect(isManagedContainer({})).toBe(false);
    expect(isManagedContainerFor({ [serverIdLabel]: serverId }, serverId)).toBe(false);
  });

  it("reads the config hash back out", () => {
    expect(containerConfigHash(managedContainerLabels(serverId, "hash-1"))).toBe("hash-1");
    expect(containerConfigHash(undefined)).toBeUndefined();
  });
});
