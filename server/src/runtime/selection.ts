import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { validateRuntimeJarFilename } from "../http/validation.js";
import { asObject, optionalString } from "../storage/valueValidation.js";
import type { ServerRuntimeProfile, ServerRuntimeType } from "../types.js";

export function runtimeSelection(input: unknown) {
  const runtime = asObject(input, "runtime");
  const canonicalRuntimeType = optionalString(runtime.runtimeType, "runtime.runtimeType");
  const legacyLoader = optionalString(runtime.loader, "runtime.loader");
  if (canonicalRuntimeType && legacyLoader && canonicalRuntimeType !== legacyLoader) {
    throw new Error("runtime.loader must match runtime.runtimeType");
  }
  const runtimeTypeValue = canonicalRuntimeType || legacyLoader || "fabric";
  if (runtimeTypeValue !== "fabric" && runtimeTypeValue !== "paper") {
    throw new Error("runtime.runtimeType must be fabric or paper");
  }
  const runtimeType: ServerRuntimeType = runtimeTypeValue;
  const canonicalRuntimeVersion = optionalString(runtime.runtimeVersion, "runtime.runtimeVersion");
  const legacyLoaderVersion = optionalString(runtime.loaderVersion, "runtime.loaderVersion");
  if (canonicalRuntimeVersion && legacyLoaderVersion && canonicalRuntimeVersion !== legacyLoaderVersion) {
    throw new Error("runtime.loaderVersion must match runtime.runtimeVersion");
  }
  const runtimeVersion = canonicalRuntimeVersion || legacyLoaderVersion;
  return {
    runtimeType,
    runtimeVersion,
    loader: runtimeType,
    minecraftVersion: optionalString(runtime.minecraftVersion, "runtime.minecraftVersion"),
    loaderVersion: runtimeVersion,
    serverJar: runtime.serverJar === undefined ? undefined : validateRuntimeJarFilename(runtime.serverJar)
  };
}

export function runtimeUpdatePlan(
  currentRuntime: ServerRuntimeProfile,
  selectedRuntime: ReturnType<typeof runtimeSelection> | undefined
) {
  const runtimeType = selectedRuntime?.runtimeType || currentRuntime.runtimeType;
  const runtimeDefinition = serverRuntimeDefinition(runtimeType);
  const minecraftVersion = selectedRuntime?.minecraftVersion || currentRuntime.minecraftVersion;
  if (!minecraftVersion) throw new Error("Minecraft version is required");
  const runtimeFamilyChanged = runtimeType !== currentRuntime.runtimeType || minecraftVersion !== currentRuntime.minecraftVersion;
  const requestedRuntimeVersion = selectedRuntime?.runtimeVersion || (runtimeFamilyChanged ? "latest" : currentRuntime.runtimeVersion || "latest");
  const serverJar = selectedRuntime?.serverJar
    || (runtimeType !== currentRuntime.runtimeType ? runtimeDefinition.serverJarFilename : currentRuntime.jarArtifact.filename);
  const shouldResolveRuntime = Boolean(selectedRuntime && (
    selectedRuntime.runtimeType !== currentRuntime.runtimeType
    || (selectedRuntime.minecraftVersion !== undefined && selectedRuntime.minecraftVersion !== currentRuntime.minecraftVersion)
    || (selectedRuntime.runtimeVersion !== undefined && selectedRuntime.runtimeVersion !== currentRuntime.runtimeVersion)
  ));
  return { runtimeType, runtimeDefinition, minecraftVersion, requestedRuntimeVersion, serverJar, shouldResolveRuntime };
}
