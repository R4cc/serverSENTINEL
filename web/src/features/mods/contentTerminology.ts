import { serverRuntimeDefinition, type ServerRuntimeType } from "@serversentinel/contracts";

export type ManagedContentTerminology = {
  runtimeName: string;
  singular: "mod" | "plugin";
  singularTitle: "Mod" | "Plugin";
  plural: "mods" | "plugins";
  pluralTitle: "Mods" | "Plugins";
  directory: string;
  modrinthProjectType: "mod" | "plugin";
  iconFallback: "MOD" | "PLG";
};

/**
 * The terminology is a pure function of the runtime type over a small closed set, but it is read on
 * every render of the mods workspace, the sidebar, and the overview. Returning a fresh object each
 * time made it useless as a memo or prop identity, so each runtime type is built once and shared.
 */
const terminologyByRuntimeType = new Map<ServerRuntimeType, ManagedContentTerminology>();

export function managedContentTerminology(runtimeType: ServerRuntimeType = "fabric"): ManagedContentTerminology {
  const cached = terminologyByRuntimeType.get(runtimeType);
  if (cached) return cached;
  const runtime = serverRuntimeDefinition(runtimeType);
  const plugin = runtime.contentKind === "plugins";
  const terminology: ManagedContentTerminology = {
    runtimeName: runtime.displayName,
    singular: plugin ? "plugin" : "mod",
    singularTitle: plugin ? "Plugin" : "Mod",
    plural: runtime.contentKind,
    pluralTitle: plugin ? "Plugins" : "Mods",
    directory: runtime.contentDirectory,
    modrinthProjectType: runtime.modrinthProjectType,
    iconFallback: plugin ? "PLG" : "MOD"
  };
  terminologyByRuntimeType.set(runtimeType, terminology);
  return terminology;
}

export const fabricContentTerminology = managedContentTerminology("fabric");
