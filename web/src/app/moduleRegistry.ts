import { isModuleAccessible, type ModuleAccessState } from "@serversentinel/contracts";
import type { ActivePage, ModuleId } from "../types";
import { lazyPage } from "./lazyPage";

/**
 * The browser half of the module system. Every optional feature that owns a workspace page is
 * listed here once, with the dynamic import that brings it in; navigation, prefetching, and the
 * page itself all consult this table rather than naming a module directly.
 *
 * Because the import lives behind `isPageAvailable`, a module that is switched off — or that the
 * signed-in account has no permission for — never has its chunk requested. The panel enforces the
 * same two gates on every request, so this is a saving, not the security boundary.
 *
 * Adding a module means adding a chunk and one row below, plus the block in `App.tsx` that renders
 * it. Nothing else in the shell has to change.
 */
const schedulesChunk = lazyPage(() => import("../features/schedules/SchedulesModule"), (module) => module.SchedulesModule);
const managedContentChunk = lazyPage(() => import("../features/mods/ModsModule"), (module) => module.ModsModule);

export const SchedulesModule = schedulesChunk.Component;
export const ModsModule = managedContentChunk.Component;

export type WebModuleDefinition = {
  id: ModuleId;
  /** The workspace page the module owns. */
  page: ActivePage;
  preload(): Promise<unknown>;
};

export const webModules: readonly WebModuleDefinition[] = [
  { id: "schedules", page: "schedule", preload: schedulesChunk.preload },
  { id: "managedContent", page: "mods", preload: managedContentChunk.preload }
];

export function moduleForPage(page: ActivePage) {
  return webModules.find((module) => module.page === page);
}

/** Whether a page may be opened, rendered, or fetched. Pages no module owns are always available. */
export function isPageAvailable(modules: readonly ModuleAccessState[] | undefined, page: ActivePage) {
  const owner = moduleForPage(page);
  return !owner || isModuleAccessible(modules, owner.id);
}
