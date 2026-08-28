import { describe, expect, it } from "vitest";
import { modrinthSearchPageInfo } from "./pagination.js";

describe("modrinthSearchPageInfo", () => {
  it("advances by upstream rows consumed even when fewer rows survive local filtering", () => {
    expect(modrinthSearchPageInfo(20, 20, 55)).toEqual({ nextOffset: 40, hasMore: true });
    expect(modrinthSearchPageInfo(40, 15, 55)).toEqual({ nextOffset: 55, hasMore: false });
  });
});
