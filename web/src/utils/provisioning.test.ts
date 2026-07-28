import { describe, expect, it } from "vitest";
import type { OperationRecord } from "../types";
import { operationToProvisionActiveJob, serverFromOperation } from "./provisioning";

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "op-1",
    type: "server.provision",
    status: "running",
    progress: 40,
    createdAt: "2026-07-28T10:00:00.000Z",
    ...overrides
  } as OperationRecord;
}

describe("serverFromOperation", () => {
  it("returns the server a succeeded operation reported", () => {
    const server = { id: "srv-1", displayName: "Survival" };
    expect(serverFromOperation(operation({ result: { server } }))).toBe(server);
  });

  it("returns undefined when the operation carries no result", () => {
    expect(serverFromOperation(operation())).toBeUndefined();
  });

  it("returns undefined when the result has no server key", () => {
    expect(serverFromOperation(operation({ result: { ok: true } }))).toBeUndefined();
  });

  it("does not throw on a non-object result", () => {
    expect(serverFromOperation(operation({ result: "done" }))).toBeUndefined();
    expect(serverFromOperation(operation({ result: null }))).toBeUndefined();
  });
});

describe("operationToProvisionActiveJob", () => {
  it("carries progress and failure detail onto the job", () => {
    const job = operationToProvisionActiveJob(operation({
      status: "failed",
      progress: 72,
      task: "Pulling image",
      errorMessage: "registry unreachable",
      logSummary: "docker: connection refused"
    }));
    expect(job).toEqual({
      id: "op-1",
      status: "failed",
      progress: 72,
      task: "Pulling image",
      error: "registry unreachable",
      errorDetails: "docker: connection refused",
      dismissible: true
    });
  });

  it("falls back to a generic task label", () => {
    expect(operationToProvisionActiveJob(operation({ task: "" })).task).toBe("Server setup is running.");
  });

  it("keeps in-flight jobs non-dismissible", () => {
    expect(operationToProvisionActiveJob(operation({ status: "queued" })).dismissible).toBe(false);
    expect(operationToProvisionActiveJob(operation({ status: "running" })).dismissible).toBe(false);
  });

  it("allows dismissing jobs that have settled", () => {
    expect(operationToProvisionActiveJob(operation({ status: "succeeded" })).dismissible).toBe(true);
    expect(operationToProvisionActiveJob(operation({ status: "failed" })).dismissible).toBe(true);
    expect(operationToProvisionActiveJob(operation({ status: "cancelled" })).dismissible).toBe(true);
  });
});
