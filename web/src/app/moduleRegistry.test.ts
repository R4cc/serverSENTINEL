import { describe, expect, it } from "vitest";
import type { ModuleAccessState } from "../types";
import { isPageAvailable, moduleForPage, webModules } from "./moduleRegistry";

const enabledForEveryone: ModuleAccessState[] = [
  { id: "schedules", enabled: true, accessible: true },
  { id: "managedContent", enabled: true, accessible: true }
];
const enabledWithoutPermission: ModuleAccessState[] = [
  { id: "schedules", enabled: true, accessible: false },
  { id: "managedContent", enabled: true, accessible: false }
];
const switchedOff: ModuleAccessState[] = [
  { id: "schedules", enabled: false, accessible: false },
  { id: "managedContent", enabled: false, accessible: false }
];

describe("web module registry", () => {
  it("owns the schedules and mods workspace pages and leaves core pages unowned", () => {
    expect(moduleForPage("schedule")?.id).toBe("schedules");
    expect(moduleForPage("mods")?.id).toBe("managedContent");
    expect(moduleForPage("console")).toBeUndefined();
    expect(moduleForPage("files")).toBeUndefined();
    expect(moduleForPage("settings")).toBeUndefined();
  });

  it("keeps core pages available no matter what the module catalog says", () => {
    for (const page of ["overview", "console", "files", "properties", "nodes", "settings"] as const) {
      expect(isPageAvailable(switchedOff, page)).toBe(true);
      expect(isPageAvailable(undefined, page)).toBe(true);
    }
  });

  it("withholds a module page from an installation that switched it off and from an account without its permission", () => {
    for (const page of ["schedule", "mods"] as const) {
      expect(isPageAvailable(enabledForEveryone, page)).toBe(true);
      expect(isPageAvailable(enabledWithoutPermission, page)).toBe(false);
      expect(isPageAvailable(switchedOff, page)).toBe(false);
    }
  });

  it("gates each module independently, so one being off says nothing about the other", () => {
    const onlySchedules: ModuleAccessState[] = [
      { id: "schedules", enabled: true, accessible: true },
      { id: "managedContent", enabled: false, accessible: false }
    ];
    expect(isPageAvailable(onlySchedules, "schedule")).toBe(true);
    expect(isPageAvailable(onlySchedules, "mods")).toBe(false);
  });

  it("withholds a module page until the panel has answered, so its chunk is never fetched on a guess", () => {
    expect(isPageAvailable(undefined, "schedule")).toBe(false);
    expect(isPageAvailable([], "schedule")).toBe(false);
  });

  it("gives every module a page and a loader, which is what the shell relies on to gate them", () => {
    expect(webModules.length).toBeGreaterThan(0);
    for (const module of webModules) {
      expect(module.page).toBeTruthy();
      expect(typeof module.preload).toBe("function");
    }
  });
});
