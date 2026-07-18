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

export function managedContentTerminology(runtimeType: ServerRuntimeType = "fabric"): ManagedContentTerminology {
  const runtime = serverRuntimeDefinition(runtimeType);
  const plugin = runtime.contentKind === "plugins";
  return {
    runtimeName: runtime.displayName,
    singular: plugin ? "plugin" : "mod",
    singularTitle: plugin ? "Plugin" : "Mod",
    plural: runtime.contentKind,
    pluralTitle: plugin ? "Plugins" : "Mods",
    directory: runtime.contentDirectory,
    modrinthProjectType: runtime.modrinthProjectType,
    iconFallback: plugin ? "PLG" : "MOD"
  };
}

export const fabricContentTerminology = managedContentTerminology("fabric");
