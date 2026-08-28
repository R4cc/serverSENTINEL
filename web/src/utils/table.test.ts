import { describe, expect, it } from "vitest";
import { nextTableSort, simpleTableAriaSort } from "./table";

describe("simple table sorting", () => {
  it("starts a new column ascending and toggles the active column", () => {
    const first = nextTableSort({ id: "name", desc: false }, "role");
    expect(first).toEqual({ id: "role", desc: false });
    expect(nextTableSort(first, "role")).toEqual({ id: "role", desc: true });
  });

  it("reports aria-sort for the header cell", () => {
    const sort = { id: "name" as const, desc: true };
    expect(simpleTableAriaSort(sort, "name")).toBe("descending");
    expect(simpleTableAriaSort(sort, "role" as "name" | "role")).toBe("none");
  });
});
