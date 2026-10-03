import { describe, expect, it } from "vitest";
import { ServerMutationCoordinator } from "./mutationCoordinator.js";

describe("server mutation reservations", () => {
  it("excludes lifecycle, content, settings and deletion while a server change awaits I/O", async () => {
    const coordinator = new ServerMutationCoordinator();
    const pending = Promise.withResolvers<void>();
    const first = coordinator.run("server", () => pending.promise);
    await expect(coordinator.run("server", async () => {})).rejects.toMatchObject({ statusCode: 409, code: "SERVER_MUTATION_IN_PROGRESS" });
    await expect(coordinator.run("other", async () => "ok")).resolves.toBe("ok");
    pending.resolve();
    await first;
    await expect(coordinator.run("server", async () => "ok")).resolves.toBe("ok");
  });

  it("allows nested helpers and releases reservations after failure", async () => {
    const coordinator = new ServerMutationCoordinator();
    await expect(coordinator.run("server", () => coordinator.run("server", async () => { throw new Error("write failed"); }))).rejects.toThrow("write failed");
    expect(coordinator.isActive("server")).toBe(false);
  });

  it("keeps independent editor saves concurrent but excludes lifecycle and settings", async () => {
    const coordinator = new ServerMutationCoordinator();
    const first = coordinator.acquire("server", true);
    const second = coordinator.acquire("server", true);
    expect(() => coordinator.acquire("server")).toThrowError(expect.objectContaining({ statusCode: 409 }));
    first.release();
    expect(coordinator.isActive("server")).toBe(true);
    second.release();
    expect(coordinator.isActive("server")).toBe(false);
  });

  it("refuses an exclusive nested change while another editor save is active", () => {
    const coordinator = new ServerMutationCoordinator();
    const first = coordinator.acquire("server", true);
    const second = coordinator.acquire("server", true);
    try { expect(() => first.run(() => coordinator.acquire("server"))).toThrowError(expect.objectContaining({ code: "SERVER_MUTATION_IN_PROGRESS" })); }
    finally { first.release(); second.release(); }
  });

  it("does not let a detached continuation reuse an expired reservation", async () => {
    const coordinator = new ServerMutationCoordinator();
    let continuation!: () => Promise<void>;
    const gate = Promise.withResolvers<void>();
    let late!: Promise<void>;
    await coordinator.run("server", async () => {
      late = gate.promise.then(() => coordinator.run("server", async () => {}));
      continuation = async () => { gate.resolve(); await late; };
    });
    const newer = coordinator.acquire("server");
    await expect(continuation()).rejects.toMatchObject({ code: "SERVER_MUTATION_IN_PROGRESS" });
    newer.release();
  });
});
