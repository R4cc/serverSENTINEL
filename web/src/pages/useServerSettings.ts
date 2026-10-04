import { useEffect, useState } from "react";
import type { ServerRuntimeType } from "@serversentinel/contracts";
import { api } from "../api";
import type { RuntimeVersion } from "../types";
import { parseJavaMemoryArgs } from "../utils/format";
import { clampNumber, fallbackFabricRuntimeVersions, fallbackMinecraftVersions, wizardJavaArgs, type CreateWizardMinecraftVersion, type MemoryBounds } from "./serverSettingsHelpers";

export function useMinecraftVersions(runtimeType: ServerRuntimeType, existingVersion?: string, serverId?: string) {
  const fallback = (): CreateWizardMinecraftVersion[] => runtimeType === "fabric" ? fallbackMinecraftVersions
    : existingVersion ? [{ version: existingVersion, stable: true, type: "release" }] : [];
  const [versions, setVersions] = useState<CreateWizardMinecraftVersion[]>(() => existingVersion ? fallback() : []);
  const [loadedRuntimeType, setLoadedRuntimeType] = useState<ServerRuntimeType>();
  useEffect(() => {
    let cancelled = false;
    api<{ versions: Array<{ id: string; type?: "release" | "snapshot" | "unknown"; supported?: boolean; recommended?: boolean }> }>(`/api/runtime/${runtimeType}/minecraft-versions`)
      .then((result) => {
        if (!cancelled) setVersions(result.versions.map((version) => ({
          version: version.id, stable: version.type === "release" && version.supported !== false,
          recommended: version.recommended, type: version.type ?? "unknown"
        })));
      })
      .catch(() => { if (!cancelled) setVersions(fallback()); })
      .finally(() => { if (!cancelled) setLoadedRuntimeType(runtimeType); });
    return () => { cancelled = true; };
  }, [runtimeType, existingVersion, serverId]);
  return { versions, loading: loadedRuntimeType !== runtimeType, resetVersions: () => { setVersions([]); setLoadedRuntimeType(undefined); } };
}

export function useRuntimeVersions(runtimeType: ServerRuntimeType, minecraftVersion: string, useFallback = false) {
  const fallback = () => useFallback && runtimeType === "fabric" ? fallbackFabricRuntimeVersions : [];
  const [versions, setVersions] = useState<RuntimeVersion[]>(fallback);
  const [loadedKey, setLoadedKey] = useState("");
  const key = `${runtimeType}:${minecraftVersion}`;
  useEffect(() => {
    if (!minecraftVersion) { setVersions([]); setLoadedKey(""); return; }
    let cancelled = false;
    api<{ runtimeVersions: RuntimeVersion[] }>(`/api/runtime/${runtimeType}/versions?minecraftVersion=${encodeURIComponent(minecraftVersion)}`)
      .then((result) => { if (!cancelled) setVersions(result.runtimeVersions); })
      .catch(() => { if (!cancelled) setVersions(fallback()); })
      .finally(() => { if (!cancelled) setLoadedKey(key); });
    return () => { cancelled = true; };
  }, [runtimeType, minecraftVersion, useFallback]);
  return { versions, loading: Boolean(minecraftVersion) && loadedKey !== key, resetVersions: () => { setVersions([]); setLoadedKey(""); } };
}

export function useJavaMemory(bounds: MemoryBounds, initial: { min: number; max: number; args: string }, syncHeapChanges = false) {
  const [minimumHeapGb, setMinimumHeapGb] = useState(initial.min);
  const [maximumHeapGb, setMaximumHeapGb] = useState(initial.max);
  const [javaArgs, setJavaArgs] = useState(initial.args);
  useEffect(() => {
    setMinimumHeapGb((current) => Math.min(clampNumber(current, bounds.min, bounds.max), maximumHeapGb));
    setMaximumHeapGb((current) => Math.max(clampNumber(current, bounds.min, bounds.max), minimumHeapGb));
  }, [bounds.min, bounds.max, minimumHeapGb, maximumHeapGb]);
  useEffect(() => {
    if (syncHeapChanges) setJavaArgs((current) => wizardJavaArgs(minimumHeapGb, maximumHeapGb, current));
  }, [syncHeapChanges, minimumHeapGb, maximumHeapGb]);
  function updateMinimumHeap(value: number) {
    const next = clampNumber(Math.round(value), bounds.min, Math.min(bounds.max, maximumHeapGb));
    setMinimumHeapGb(next);
    setJavaArgs((current) => wizardJavaArgs(next, maximumHeapGb, current));
  }
  function updateMaximumHeap(value: number) {
    const next = clampNumber(Math.round(value), Math.max(bounds.min, minimumHeapGb), bounds.max);
    setMaximumHeapGb(next);
    setJavaArgs((current) => wizardJavaArgs(minimumHeapGb, next, current));
  }
  function updateJavaArgs(value: string) {
    setJavaArgs(value);
    const memory = parseJavaMemoryArgs(value);
    if (memory.xmsGb !== null) setMinimumHeapGb(clampNumber(memory.xmsGb, bounds.min, Math.min(bounds.max, maximumHeapGb)));
    if (memory.xmxGb !== null) setMaximumHeapGb(clampNumber(memory.xmxGb, Math.max(bounds.min, minimumHeapGb), bounds.max));
  }
  function resetMemory(min: number, max: number, args: string) {
    setMinimumHeapGb(min); setMaximumHeapGb(max); setJavaArgs(wizardJavaArgs(min, max, args));
  }
  return { minimumHeapGb, maximumHeapGb, javaArgs, updateMinimumHeap, updateMaximumHeap, updateJavaArgs, resetMemory };
}
