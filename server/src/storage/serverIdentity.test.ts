import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultServerContainerName, isInsideServersDirectory, serverDirectory, serverStorageName } from "./serverIdentity.js";

describe("server identity helpers", () => {
  it("derives persistent names from immutable server ids", () => {
    const serverId = "00000000-0000-4000-8000-000000000001";

    expect(serverStorageName(serverId)).toBe(serverId);
    expect(serverDirectory("/data/servers", serverId)).toBe(resolve("/data/servers", serverId));
    expect(defaultServerContainerName(serverId)).toBe(`serversentinel-${serverId}`);
  });

  it("checks server directories against the canonical servers root", () => {
    const root = resolve("/data/servers");
    expect(isInsideServersDirectory(root, join(root, "00000000-0000-4000-8000-000000000001"))).toBe(true);
    expect(isInsideServersDirectory(root, resolve("/data/servers-other/id"))).toBe(false);
  });
});
