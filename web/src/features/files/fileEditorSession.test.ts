import { describe, expect, it } from "vitest";
import { ApiError } from "../../api";
import type { FileEditLease, FileEntry } from "../../types";
import { fileLeaseConflictMessage, fileSaveError, unsupportedEditorMessage } from "./fileEditorSession";

describe("file editor session helpers", () => {
  it("describes unsupported editor entries", () => {
    const directory = { type: "directory", size: 0 } as FileEntry;
    const largeFile = { type: "file", size: 2 * 1024 * 1024 + 1 } as FileEntry;
    const binaryFile = { type: "file", size: 1_024 } as FileEntry;

    expect(unsupportedEditorMessage(directory)).toContain("Folders");
    expect(unsupportedEditorMessage(largeFile)).toContain("2 MiB");
    expect(unsupportedEditorMessage(binaryFile)).toContain("text files");
  });

  it("includes lease owner details in conflict messages", () => {
    const lease = {
      displayName: "Operator",
      refreshedAt: "2026-07-15T10:00:00.000Z"
    } as FileEditLease;
    const error = new ApiError("Conflict", 409, "FILE_EDIT_LEASE_CONFLICT", { lease });

    expect(fileLeaseConflictMessage(error, () => "15 Jul 2026, 12:00")).toContain("Operator is editing this file");
    expect(fileLeaseConflictMessage(error, () => "15 Jul 2026, 12:00")).toContain("15 Jul 2026, 12:00");
  });

  it("classifies revision and lease-loss save conflicts", () => {
    expect(fileSaveError(new ApiError("Changed", 409, "FILE_REVISION_CONFLICT"))).toMatchObject({ conflict: true, message: expect.stringContaining("changed outside") });
    expect(fileSaveError(new ApiError("Lost", 409, "FILE_EDIT_LEASE_LOST"))).toMatchObject({ conflict: true, message: expect.stringContaining("lease expired") });
    expect(fileSaveError(new Error("Disk unavailable"))).toEqual({ conflict: false, message: "Disk unavailable" });
  });
});
