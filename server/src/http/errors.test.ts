import { describe, expect, it } from "vitest";
import { publicApiError, stableErrorCode } from "./errors.js";

function error(message: string, input: { code?: string; details?: unknown; statusCode?: number } = {}) {
  const err = new Error(message) as Error & { code?: string; details?: unknown; statusCode?: number };
  err.code = input.code;
  err.details = input.details;
  err.statusCode = input.statusCode;
  return err;
}

describe("structured API errors", () => {
  it("normalizes explicit error codes and object details into the public envelope", () => {
    expect(publicApiError(error("Someone else is editing this file", {
      code: "file_edit_lease_conflict",
      details: { lease: { displayName: "Alex" } }
    }), 409)).toEqual({
      error: {
        code: "FILE_EDIT_LEASE_CONFLICT",
        message: "Someone else is editing this file",
        details: { lease: { displayName: "Alex" } }
      }
    });
  });

  it("gives expected user failures stable machine-readable codes", () => {
    expect(stableErrorCode(error("Authentication required"), 401)).toBe("AUTHENTICATION_REQUIRED");
    expect(stableErrorCode(error("You need permission to manage users before performing this action."), 403)).toBe("PERMISSION_DENIED");
    expect(stableErrorCode(error("Node not found"), 404)).toBe("NOT_FOUND");
    expect(stableErrorCode(error("Port 25565/tcp is already used on this node."), 400)).toBe("PORT_CONFLICT");
    expect(stableErrorCode(error("Server jar filename must be a local .jar filename"), 400)).toBe("VALIDATION_ERROR");
  });

  it("keeps internal messages and details out of public 500 responses", () => {
    expect(publicApiError(error("database password leaked", { details: { secret: "nope" } }), 500)).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        details: {}
      }
    });
  });
});
