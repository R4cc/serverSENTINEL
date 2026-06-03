import { describe, expect, it } from "vitest";
import { summarizeRuntimeExit } from "./runtimeErrors.js";

describe("runtime exit error summaries", () => {
  it("explains Fabric/Mojang DNS failures without dumping the Java stack trace", () => {
    const message = summarizeRuntimeExit("start", `
      Exception in thread "main" java.lang.RuntimeException: Failed to setup fabric server
      Caused by: java.io.IOException: Request to https://launchermeta.mojang.com/mc/game/version_manifest_v2.json using DIRECT failed: launchermeta.mojang.com
      Caused by: java.net.UnknownHostException: launchermeta.mojang.com
    `);

    expect(message).toContain("could not resolve launchermeta.mojang.com");
    expect(message).toContain("Check DNS and outbound network access");
    expect(message).not.toContain("Exception in thread");
  });
});
