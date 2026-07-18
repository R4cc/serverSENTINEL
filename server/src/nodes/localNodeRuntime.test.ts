import { describe, expect, it, vi } from "vitest";
import type { ManagedServer, PublicServer } from "../types.js";
import { LocalNodeRuntime, type LocalNodeRuntimeHandlers } from "./localNodeRuntime.js";

describe("LocalNodeRuntime", () => {
  it("delegates handlers and adapts updateServer to the local ID-based handler", async () => {
    const server = { id: "server-1" } as ManagedServer;
    const publicResult = { id: server.id } as PublicServer;
    const publicServer = vi.fn(async () => publicResult);
    const isModsPath = vi.fn(() => true);
    const updateServer = vi.fn(async () => server);
    const handlers = { publicServer, isModsPath, updateServer } as unknown as LocalNodeRuntimeHandlers;
    const runtime = new LocalNodeRuntime(handlers);

    await expect(runtime.publicServer(server)).resolves.toBe(publicResult);
    expect(runtime.isModsPath(server, "/srv/mods/example.jar")).toBe(true);
    await expect(runtime.updateServer(server, { name: "Renamed" })).resolves.toBe(server);

    expect(publicServer).toHaveBeenCalledWith(server);
    expect(isModsPath).toHaveBeenCalledWith(server, "/srv/mods/example.jar");
    expect(updateServer).toHaveBeenCalledWith("server-1", { name: "Renamed" });
  });
});
