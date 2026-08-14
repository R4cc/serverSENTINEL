import { describe, expect, it } from "vitest";
import { nodeUpdateNeedsManualRecreate } from "./nodeService.js";

describe("node self-update eligibility", () => {
  it("sends agents from before the entrypoint change through a manual recreate", () => {
    expect(nodeUpdateNeedsManualRecreate("26.8.8", undefined, "26.8.13")).toBe(true);
    expect(nodeUpdateNeedsManualRecreate("26.7.4", undefined, "26.8.11")).toBe(true);
  });

  it("lets agents that already run the current image update themselves", () => {
    expect(nodeUpdateNeedsManualRecreate("26.8.11", undefined, "26.8.13")).toBe(false);
    expect(nodeUpdateNeedsManualRecreate("26.8.12", undefined, "26.8.13")).toBe(false);
    expect(nodeUpdateNeedsManualRecreate("26.8.13", undefined, "26.8.13")).toBe(false);
  });

  it("stays out of the way for unknown versions and operator-chosen images", () => {
    expect(nodeUpdateNeedsManualRecreate(undefined, undefined, "26.8.13")).toBe(false);
    expect(nodeUpdateNeedsManualRecreate("nightly", undefined, "26.8.13")).toBe(false);
    expect(nodeUpdateNeedsManualRecreate("26.8.8", "ghcr.io/example/node:custom", "26.8.13")).toBe(false);
    expect(nodeUpdateNeedsManualRecreate("26.8.8", undefined, "26.8.10")).toBe(false);
  });
});
