import { describe, expect, it } from "vitest";
import { storageSpaceFromStats } from "./storageSpace.js";

describe("server storage space", () => {
  it("reports filesystem capacity and bytes available to the server process", () => {
    expect(storageSpaceFromStats({ blocks: 1_000, bavail: 80, bsize: 4_096 })).toEqual({
      totalBytes: 4_096_000,
      availableBytes: 327_680
    });
  });

  it("does not expose negative filesystem counters", () => {
    expect(storageSpaceFromStats({ blocks: -1, bavail: -1, bsize: 4_096 })).toEqual({
      totalBytes: 0,
      availableBytes: 0
    });
  });
});
