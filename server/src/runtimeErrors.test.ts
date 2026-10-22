import { describe, expect, it } from "vitest";
import { summarizeRuntimeExit } from "./runtimeErrors.js";

describe("runtime exit error summaries", () => {
  it("explains Fabric/Mojang DNS failures without dumping the Java stack trace", () => {
    const message = summarizeRuntimeExit("start", `
      Exception in thread "main" java.lang.RuntimeException: Failed to setup fabric server
      Caused by: java.io.IOException: Request to https://launchermeta.mojang.com/mc/game/version_manifest_v2.json using DIRECT failed: launchermeta.mojang.com
      Caused by: java.net.UnknownHostException: launchermeta.mojang.com
    `);

    expect(message).toContain("DNS resolution failed");
    expect(message).not.toContain("launchermeta.mojang.com");
    expect(message).toContain("Check DNS and outbound network access");
    expect(message).not.toContain("Exception in thread");
  });

  it("does not copy console text into public operation errors", () => {
    for (const action of ["start", "restart"] as const) {
      expect(summarizeRuntimeExit(action, "private-console-marker: player address and credentials")).not.toContain("private-console-marker");
    }
    expect(summarizeRuntimeExit("start", "UnknownHostException: private-console-marker")).not.toContain("private-console-marker");
  });
});
