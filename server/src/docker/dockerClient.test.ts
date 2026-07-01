import { describe, expect, it } from "vitest";
import { dockerErrorMessage, dockerJsonBody } from "./dockerClient.js";

describe("Docker client helpers", () => {
  it("uses Docker error messages when present", () => {
    expect(dockerErrorMessage(JSON.stringify({ message: "container already exists" }), 409)).toBe("container already exists");
    expect(dockerErrorMessage("plain failure", 500)).toBe("plain failure");
    expect(dockerErrorMessage("", 404)).toBe("Docker API returned 404");
  });

  it("parses successful JSON bodies and rejects malformed responses", () => {
    expect(dockerJsonBody<{ Id: string }>(JSON.stringify({ Id: "abc" }))).toEqual({ Id: "abc" });
    expect(dockerJsonBody<Record<string, never>>("")).toEqual({});
    expect(() => dockerJsonBody("{")).toThrow("Docker API returned malformed JSON");
  });
});
