import { describe, expect, it } from "vitest";
import { MODULE_IDS } from "@serversentinel/contracts";
import type { ModuleAccessState } from "../types";
import { pageTitle } from "./appConfig";
import { readStoredActivePage, writeStoredActivePage } from "./navigationStorage";
import { pagePrefetchOrder } from "./pagePrefetch";
import { isPageAvailable, moduleAccessSignature, moduleForPage, resolveAvailablePage, webModules } from "./moduleRegistry";

const enabledForEveryone: ModuleAccessState[] = [
  { id: "schedules", enabled: true, accessible: true },
  { id: "managedContent", enabled: true, accessible: true },
  { id: "playerInsights", enabled: true, accessible: true }
];
const enabledWithoutPermission: ModuleAccessState[] = [
  { id: "schedules", enabled: true, accessible: false },
  { id: "managedContent", enabled: true, accessible: false },
  { id: "playerInsights", enabled: true, accessible: false }
];
const switchedOff: ModuleAccessState[] = [
  { id: "schedules", enabled: false, accessible: false },
  { id: "managedContent", enabled: false, accessible: false },
  { id: "playerInsights", enabled: false, accessible: false }
];

describe("web module registry", () => {
  it("owns the schedules and mods workspace pages and leaves core pages unowned", () => {
    expect(moduleForPage("schedule")?.id).toBe("schedules");
    expect(moduleForPage("mods")?.id).toBe("managedContent");
    expect(moduleForPage("players")?.id).toBe("playerInsights");
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
    for (const page of ["schedule", "mods", "players"] as const) {
      expect(isPageAvailable(enabledForEveryone, page)).toBe(true);
      expect(isPageAvailable(enabledWithoutPermission, page)).toBe(false);
      expect(isPageAvailable(switchedOff, page)).toBe(false);
    }
  });

  it("gates each module independently, so one being off says nothing about the other", () => {
    const onlySchedules: ModuleAccessState[] = [
      { id: "schedules", enabled: true, accessible: true },
      { id: "managedContent", enabled: false, accessible: false },
      { id: "playerInsights", enabled: false, accessible: false }
    ];
    expect(isPageAvailable(onlySchedules, "schedule")).toBe(true);
    expect(isPageAvailable(onlySchedules, "mods")).toBe(false);
    expect(isPageAvailable(onlySchedules, "players")).toBe(false);
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

  it("gives the same signature to catalogs that mean the same thing, and different ones otherwise", () => {
    expect(moduleAccessSignature(enabledForEveryone)).toBe(moduleAccessSignature([...enabledForEveryone]));
    expect(moduleAccessSignature(enabledForEveryone)).not.toBe(moduleAccessSignature(enabledWithoutPermission));
    expect(moduleAccessSignature(enabledWithoutPermission)).not.toBe(moduleAccessSignature(switchedOff));
    expect(moduleAccessSignature(undefined)).toBe(moduleAccessSignature([]));
  });

  it("sends an unreachable module page to the overview, however it was reached", () => {
    expect(resolveAvailablePage("mods", switchedOff)).toBe("overview");
    expect(resolveAvailablePage("schedule", enabledWithoutPermission)).toBe("overview");
    // Not yet known is treated the same, so a restored page cannot flash a module in before the
    // panel has said whether this account may have it.
    expect(resolveAvailablePage("mods", undefined)).toBe("overview");

    expect(resolveAvailablePage("mods", enabledForEveryone)).toBe("mods");
    for (const page of ["overview", "console", "files", "properties", "nodes", "settings"] as const) {
      expect(resolveAvailablePage(page, switchedOff)).toBe(page);
    }
  });
});

/**
 * A module has to be wired into a handful of core lists that cannot be derived from the registry —
 * the page union, the stored-navigation allowlist, the prefetch queue, the workspace title. These
 * fail loudly when a module is added without one of them, which is cheaper than machinery that
 * makes each list module-aware and easier to trust than a checklist in a document.
 */
describe("core wiring every module page depends on", () => {
  it("declares each module id in the shared catalog", () => {
    for (const module of webModules) expect(MODULE_IDS).toContain(module.id);
  });

  it("accepts each module page as a restorable navigation target", () => {
    for (const module of webModules) {
      const storage = new Map<string, string>();
      const fakeStorage = {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); }
      } as unknown as Storage;
      writeStoredActivePage(module.page, fakeStorage, 0);
      expect(readStoredActivePage(fakeStorage, 0), module.id).toBe(module.page);
    }
  });

  it("queues each module page for idle prefetching", () => {
    for (const module of webModules) expect(pagePrefetchOrder, module.id).toContain(module.page);
  });

  it("gives each module page a workspace title", () => {
    for (const module of webModules) {
      expect(pageTitle(module.page, "Mods", true), module.id).not.toBe("Welcome");
    }
  });
});
