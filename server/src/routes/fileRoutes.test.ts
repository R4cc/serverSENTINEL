import Fastify, { type FastifyInstance } from "fastify";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeRuntime } from "../nodes/types.js";
import type { ManagedServer, Permission, StoredUser } from "../types.js";
import { openStorageDatabase, type StorageDatabase } from "../storage/database.js";
import { FileEditLeasesRepository, fileEditLeaseTimeoutMs } from "../storage/fileEditLeasesRepository.js";
import { fileContentRevision } from "../files/fileService.js";
import { registerFileRoutes } from "./fileRoutes.js";

const context = vi.hoisted(() => ({
  services: {} as typeof import("../appServices.js").services,
  runtime: undefined as NodeRuntime | undefined,
  server: undefined as ManagedServer | undefined,
  user: undefined as StoredUser | undefined,
  running: false
}));

vi.mock("../appServices.js", () => ({ services: context.services, runtimeForServer: () => context.runtime }));
vi.mock("../servers/store.js", () => ({ getServer: async () => context.server }));
vi.mock("../auth/sessionService.js", () => ({
  sessionCookieName: "ss",
  parseCookies: () => new Map([["ss", "session-1"]]),
  requireRequestPermission: async (_request: unknown, permission?: Permission) => {
    if (permission && !context.user?.permissions.includes(permission)) {
      throw Object.assign(new Error("Permission denied"), { statusCode: 403 });
    }
    return context.user;
  }
}));
vi.mock("../mods/modService.js", () => ({ withTrackedModMutation: (_server: unknown, action: () => Promise<unknown>) => action() }));
vi.mock("../servers/lifecycle.js", () => ({
  operationErrorMessage: (error: Error) => error.message,
  requireServerStoppedForMutableConfiguration: async () => {
    if (context.running) throw Object.assign(new Error("Server must be stopped"), { statusCode: 409 });
  }
}));

let app: FastifyInstance;
let storage: StorageDatabase;
let leases: FileEditLeasesRepository;
let contents: Map<string, string>;
let readFile: ReturnType<typeof vi.fn<(server: ManagedServer, path: string) => Promise<{ content: string }>>>;
let writeFile: ReturnType<typeof vi.fn<(server: ManagedServer, path: string, content: unknown) => Promise<{ ok: boolean }>>>;
let duplicateFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storage = openStorageDatabase(":memory:");
  storage.connection.exec(`
    INSERT INTO users (id, username, password_hash, salt, role_preset, permissions_json, created_at, updated_at)
      VALUES ('user-1', 'alice', 'hash', 'salt', 'custom', '[]', 'now', 'now');
    INSERT INTO sessions (id, user_id, created_at) VALUES ('session-1', 'user-1', 'now');
    INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at)
      VALUES ('remote', 'Remote', 'remote', 'online', 0, 'now', 'now');
    INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, created_at, updated_at)
      VALUES ('server', 'remote', 'Server', '/server', '{}', 'now', 'now');
  `);
  leases = new FileEditLeasesRepository(storage);
  context.server = {
    id: "server", nodeId: "remote", displayName: "Server", serverDir: "/server",
    runtimeProfile: { minecraftVersion: "1.21.1", runtimeType: "fabric", runtimeVersion: "0.16.0", jarArtifact: { filename: "server.jar" } }
  } as ManagedServer;
  context.user = { id: "user-1", username: "alice", permissions: ["files.view", "files.edit", "files.upload", "users.manage"] } as StoredUser;
  context.running = false;
  context.services.fileEditLeasesRepository = leases;
  context.services.operationsRepository = { listActive: () => [] } as unknown as typeof context.services.operationsRepository;
  context.services.exportCoordinator = { withMutation: (_id: string, action: () => Promise<unknown>) => action() } as unknown as typeof context.services.exportCoordinator;
  contents = new Map([["config.txt", "original"], ["other.txt", "other"]]);
  readFile = vi.fn(async (_server: ManagedServer, path: string) => ({ content: contents.get(path)! }));
  writeFile = vi.fn(async (_server: ManagedServer, path: string, content: unknown) => {
    contents.set(path, content as string);
    return { ok: true };
  });
  duplicateFile = vi.fn(async () => ({ ok: true }));
  context.runtime = {
    resolveExistingPath: async (_server: ManagedServer, path: string) => path.replace(/^\//, ""),
    resolveWritableResolvedPath: async (_server: ManagedServer, path: string) => path.replace(/^\//, ""),
    publicPath: (_server: ManagedServer, path: string) => `/${path}`,
    isServerSettingsFile: (_server: ManagedServer, path: string) => path === "server.properties",
    isModsPath: () => false,
    readFile,
    writeFile,
    duplicateFile
  } as unknown as NodeRuntime;
  app = Fastify();
  registerFileRoutes(app);
});

afterEach(async () => {
  await app.close();
  storage.close();
  vi.restoreAllMocks();
});

async function acquire(path = "config.txt", revision = fileContentRevision(contents.get(path)!)) {
  const response = await app.inject({ method: "POST", url: "/api/servers/server/file/lease", payload: { path, revision } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().lease.leaseId as string;
}

function save(leaseId: string, content: string, path = "config.txt", revision = fileContentRevision("original")) {
  return app.inject({ method: "PUT", url: "/api/servers/server/file", payload: { path, leaseId, content, revision } }).then((response) => response);
}

describe("file edit concurrency", () => {
  it("allows one save for a lease and rejects a concurrent stale save", async () => {
    const leaseId = await acquire();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    writeFile.mockImplementationOnce(async (_server, path, content) => {
      entered.resolve();
      await resume.promise;
      contents.set(path, content as string);
      return { ok: true };
    });
    const first = save(leaseId, "first");
    await entered.promise;
    const second = save(leaseId, "second");
    await setImmediate();
    expect(writeFile).toHaveBeenCalledTimes(1);
    resume.resolve();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 409]);
    expect(contents.get("config.txt")).toBe("first");
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("lets independent files save while another file is waiting on I/O", async () => {
    const leaseId = await acquire();
    const otherLease = await acquire("other.txt");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    writeFile.mockImplementationOnce(async (_server, path, content) => {
      entered.resolve();
      await resume.promise;
      contents.set(path, content as string);
      return { ok: true };
    });
    const first = save(leaseId, "first");
    await entered.promise;
    try {
      const other = await save(otherLease, "updated other", "other.txt", fileContentRevision("other"));
      expect(other.statusCode, other.body).toBe(200);
      expect(contents.get("other.txt")).toBe("updated other");
    } finally {
      resume.resolve();
      await first;
    }
  });

  it("serializes forced release and reacquisition after an in-flight save", async () => {
    const leaseId = await acquire();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    writeFile.mockImplementationOnce(async (_server, path, content) => {
      entered.resolve();
      await resume.promise;
      contents.set(path, content as string);
      return { ok: true };
    });
    const first = save(leaseId, "first");
    await entered.promise;
    let released = false;
    const release = app.inject({ method: "DELETE", url: `/api/servers/server/file/lease/${leaseId}?force=true` }).then((response) => {
      released = true;
      return response;
    });
    await setImmediate();
    expect(released).toBe(false);
    const next = acquire("config.txt", fileContentRevision("first"));
    resume.resolve();
    expect((await first).statusCode).toBe(200);
    expect((await release).statusCode).toBe(200);
    const nextLease = await next;
    expect((await save(leaseId, "stale")).statusCode).toBe(409);
    expect((await save(nextLease, "next", "config.txt", fileContentRevision("first"))).statusCode).toBe(200);
    expect(contents.get("config.txt")).toBe("next");
  });

  it("rechecks lease expiry after a slow read before writing", async () => {
    const leaseId = await acquire();
    const now = Date.now();
    readFile.mockImplementationOnce(async (_server, path) => {
      vi.spyOn(Date, "now").mockReturnValue(now + fileEditLeaseTimeoutMs + 1);
      return { content: contents.get(path)! };
    });
    const response = await save(leaseId, "expired");
    expect(response.statusCode).toBe(409);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("leaves a lease usable after a write fails", async () => {
    const leaseId = await acquire();
    writeFile.mockRejectedValueOnce(new Error("Node unavailable"));
    expect((await save(leaseId, "failed")).statusCode).toBe(500);
    expect((await save(leaseId, "retried")).statusCode).toBe(200);
    expect(contents.get("config.txt")).toBe("retried");
  });
});

describe("file duplication settings protection", () => {
  it("rejects an ordinary file duplicated to server.properties without settings permission", async () => {
    const response = await app.inject({ method: "POST", url: "/api/servers/server/file/duplicate", payload: { path: "config.txt", name: "server.properties" } });
    expect(response.statusCode).toBe(403);
    expect(duplicateFile).not.toHaveBeenCalled();
  });

  it("requires a stopped server for a settings destination and permits authorized duplication when stopped", async () => {
    context.user!.permissions.push("servers.editSettings");
    context.running = true;
    const request = { method: "POST" as const, url: "/api/servers/server/file/duplicate", payload: { path: "config.txt", name: "server.properties" } };
    expect((await app.inject(request)).statusCode).toBe(409);
    expect(duplicateFile).not.toHaveBeenCalled();
    context.running = false;
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(duplicateFile).toHaveBeenCalledWith(context.server, "config.txt", "server.properties");
  });

  it("keeps ordinary duplication available and resolves remote subdirectories with slash paths", async () => {
    const resolveTarget = vi.spyOn(context.runtime!, "resolveWritableResolvedPath");
    context.running = true;
    const response = await app.inject({ method: "POST", url: "/api/servers/server/file/duplicate", payload: { path: "config/config.txt", name: "copy.txt" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(resolveTarget).toHaveBeenCalledWith(context.server, "config/copy.txt");
  });
});
