import { describe, expect, it } from "vitest";
import { provisioningErrorMessage } from "./provisioning.js";

describe("provisioningErrorMessage", () => {
  it("sanitizes Docker connection failures", () => {
    expect(provisioningErrorMessage(new Error("connect ENOTSOCK C:\\private\\docker.fake")))
      .toBe("Docker is not reachable on the selected node. Check the Docker connection, then try again.");
  });

  it("preserves actionable validation failures", () => {
    expect(provisioningErrorMessage(new Error("A managed server with this display name already exists")))
      .toBe("A managed server with this display name already exists");
  });

  it("does not mislabel unrelated filesystem errors as Docker failures", () => {
    expect(provisioningErrorMessage(new Error("ENOENT: no such file or directory, open 'server.jar'")))
      .toBe("ENOENT: no such file or directory, open 'server.jar'");
  });
});
