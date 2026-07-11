import { describe, expect, it } from "vitest";
import { adjacentFilePath, retainedFileFocus, updateFileSelection } from "./fileSelection";

const paths = ["/alpha", "/bravo", "/charlie", "/delta"];

describe("file selection helpers", () => {
  it("replaces selection on a plain click", () => {
    expect(updateFileSelection(["/alpha"], paths, "/charlie", "/alpha")).toEqual({
      selectedPaths: ["/charlie"],
      anchorPath: "/charlie"
    });
  });

  it("toggles one item while preserving sorted selection order", () => {
    expect(updateFileSelection(["/charlie"], paths, "/alpha", "/charlie", { toggle: true })).toEqual({
      selectedPaths: ["/alpha", "/charlie"],
      anchorPath: "/alpha"
    });
  });

  it("selects a contiguous range from the stable anchor", () => {
    expect(updateFileSelection(["/bravo"], paths, "/delta", "/bravo", { range: true })).toEqual({
      selectedPaths: ["/bravo", "/charlie", "/delta"],
      anchorPath: "/bravo"
    });
  });

  it("adds a range to the current selection when requested", () => {
    expect(updateFileSelection(["/alpha"], paths, "/delta", "/charlie", { range: true, additive: true }).selectedPaths).toEqual([
      "/alpha", "/charlie", "/delta"
    ]);
  });

  it("clamps keyboard focus and drops focus that no longer exists", () => {
    expect(adjacentFilePath(paths, "/alpha", -1)).toBe("/alpha");
    expect(adjacentFilePath(paths, "/charlie", 1)).toBe("/delta");
    expect(retainedFileFocus("/bravo", paths)).toBe("/bravo");
    expect(retainedFileFocus("/missing", paths)).toBe("");
  });
});
