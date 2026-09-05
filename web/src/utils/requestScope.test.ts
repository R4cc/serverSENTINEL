import { describe, expect, it } from "vitest";
import { createRequestScope } from "./requestScope";

describe("request ownership", () => {
  it("rejects results from a previous lifetime even after returning to the same entity", () => {
    const scope = createRequestScope();
    const old = scope.begin("A");
    scope.invalidate();
    scope.begin("B");
    scope.invalidate();
    const current = scope.begin("A");
    expect(old()).toBe(false);
    expect(current()).toBe(true);
  });

  it("supersedes only the matching request lane", () => {
    const scope = createRequestScope();
    const first = scope.begin("details");
    const other = scope.begin("install");
    const second = scope.begin("details");
    expect(first()).toBe(false);
    expect(other()).toBe(true);
    expect(second()).toBe(true);
    scope.invalidate();
    expect(other()).toBe(false);
    expect(second()).toBe(false);
  });
});
