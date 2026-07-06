import { useEffect, useMemo, useRef, useState, type ChangeEvent, type Dispatch, type SetStateAction } from "react";
import { api, ApiError } from "../../api";
import { demoSearchResults, demoServerId } from "../../demo";
import type { ActivePage, GeneralJob, InstalledMod, ManagedServer, ModrinthHit, ModrinthInstallVersion, ModrinthInstallVersionsResponse, ModUpdatePlan, ReleaseChannel, SafeBatchUpdateResult } from "../../types";
import type { ModInstallModalState } from "../../app/uiState";
import { bufferToBase64 } from "../../utils/files";
import { errorMessage } from "../../utils/appHelpers";
import { getInstallVersionHealth } from "./modHealth";
import { buildModrinthSearchPath, fallbackReleaseChannel, filterDemoSearchResults, hasInstallVersions, installedModKey, pendingRequiredDependencies, preferredInstallVersionId, safeBatchUpdateFeedback, selectedInstallFlags, uploadedManualMod, validateModUploadSelection } from "./modsWorkspaceHelpers";
import { createDemoUpdatePlan, safeUpdateRequestGroups } from "./modUpdatePlan";
import { demoFixtureFailureMessage, readModsDemoFixture } from "./modsDemoFixtures";

const modSearchDebounceMs = 650;
const modrinthRetryDelayMs = 1500;

type Notify = (type: "success" | "error" | "info" | "warning", text: string) => void;

function waitForRetry(signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(new DOMException("The request was cancelled.", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, modrinthRetryDelayMs);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timeout);
      reject(new DOMException("The request was cancelled.", "AbortError"));
    }, { once: true });
  });
}

function shouldRetryModrinthError(error: unknown) {
  if (error instanceof ApiError) return error.status === 429 || error.status >= 500;
  return true;
}

function mergeSafeBatchUpdateResults(results: SafeBatchUpdateResult[]): SafeBatchUpdateResult {
  return {
    updated: results.flatMap((result) => result.updated),
    skipped: results.flatMap((result) => result.skipped),
    failed: results.flatMap((result) => result.failed),
    counts: {
      requested: results.reduce((total, result) => total + result.counts.requested, 0),
      updated: results.reduce((total, result) => total + result.counts.updated, 0),
      skipped: results.reduce((total, result) => total + result.counts.skipped, 0),
      failed: results.reduce((total, result) => total + result.counts.failed, 0)
    }
  };
}

function mergeStableModMetadata(previous: InstalledMod[], incoming: InstalledMod[]) {
  const previousByFilename = new Map(previous.map((mod) => [mod.filename, mod]));
  return incoming.map((mod) => {
    const existing = previousByFilename.get(mod.filename);
    if (!existing) return mod;
    const incomingCompatibilityUnknown = !mod.compatibility || mod.compatibility.status === "unknown";
    const existingCompatibilityKnown = existing.compatibility && existing.compatibility.status !== "unknown";
    return {
      ...mod,
      displayName: mod.displayName || existing.displayName,
      description: mod.description || existing.description,
      iconUrl: mod.iconUrl || existing.iconUrl,
      modrinth: mod.modrinth || existing.modrinth,
      versionInfo: mod.versionInfo || existing.versionInfo,
      compatibility: incomingCompatibilityUnknown && existingCompatibilityKnown ? existing.compatibility : mod.compatibility
    };
  });
}

export type ModsWorkspaceInputs = {
  activeServer?: ManagedServer;
  activePage: ActivePage;
  activeServerIsDemo: boolean;
  activeServerUsesInternalNode: boolean;
  activeNodeRuntimeBlocked: boolean;
  activeNodeBlockMessage: string;
  demoMode: boolean;
  demoInstalledMods: InstalledMod[];
  setDemoInstalledMods: Dispatch<SetStateAction<InstalledMod[]>>;
  modrinthConfigured: boolean;
  isProvisioning: boolean;
  canManage: boolean;
  modsLocked: boolean;
  toggleLocked: boolean;
  notify: Notify;
  setNotice: Dispatch<SetStateAction<string>>;
  setActiveJobs: Dispatch<SetStateAction<GeneralJob[]>>;
  handleStaleSession: (error: unknown) => boolean;
  refreshFiles: (serverId: string, path: string) => Promise<unknown>;
};

export type ModsWorkspaceController = ReturnType<typeof useModsWorkspace>;

function demoInstallVersions(server: ManagedServer | undefined, mod: ModrinthHit, channel: ReleaseChannel): ModrinthInstallVersionsResponse {
  const minecraftVersion = server?.runtimeProfile.minecraftVersion || "1.21.1";
  const now = new Date().toISOString();
  return {
    project: {
      id: mod.project_id,
      title: mod.title,
      description: mod.description,
      iconUrl: mod.icon_url,
      clientSide: mod.client_side,
      serverSide: mod.server_side ?? "optional"
    },
    target: {
      serverId: server?.id || demoServerId,
      serverName: server?.displayName || "Demo Server",
      minecraftVersion,
      loader: "Fabric"
    },
    channel,
    compatibleVersions: [{
      id: `${mod.project_id}-demo-compatible`,
      versionNumber: mod.compatibility?.matchedVersionNumber || "1.0.0",
      releaseChannel: channel,
      publishedAt: now,
      minecraftVersions: [minecraftVersion],
      loaders: ["fabric"],
      file: { filename: `${mod.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.jar`, size: mod.compatibility?.file?.size ?? 1_048_576 },
      compatible: true,
      selectable: true,
      requiresMinecraftAcknowledgement: false,
      status: "recommended",
      statusLabel: "Recommended",
      reason: "Compatible Fabric server mod",
      dependencies: [{ projectId: "fabric-api", dependencyType: "required", title: "Fabric API" }]
    }],
    otherVersions: [{
      id: `${mod.project_id}-demo-mismatch`,
      versionNumber: "0.9.0",
      releaseChannel: "release",
      publishedAt: now,
      minecraftVersions: ["1.20.1"],
      loaders: ["fabric"],
      file: { filename: `${mod.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-old.jar`, size: 900_000 },
      compatible: false,
      selectable: true,
      requiresMinecraftAcknowledgement: true,
      status: "version_mismatch",
      statusLabel: "Version mismatch",
      reason: `Not marked for Minecraft ${minecraftVersion}`,
      dependencies: []
    }]
  };
}

function demoSearchPage(query: string, showIncompatibleResults: boolean) {
  const value = query.toLowerCase();
  const baseFiltered = demoSearchResults.filter((mod) => !value || mod.title.toLowerCase().includes(value) || mod.description.toLowerCase().includes(value));
  const extraMods: ModrinthHit[] = [];
  if (value.length <= 3) {
    for (let index = 1; index <= 40; index += 1) {
      extraMods.push({
        project_id: `demo-dummy-${index}`,
        title: `Fabric Mod Helper ${index}`,
        description: `A generated dummy mod to showcase infinite scrolling in demo mode. Index ${index}.`,
        downloads: 100000 + index * 5000,
        date_modified: new Date().toISOString(),
        compatibility: { status: "compatible", compatible: true, reason: "Compatible server-side Fabric mod", serverSide: "optional", clientSide: "optional" },
        server_side: "optional",
        client_side: "optional"
      });
    }
  }
  return filterDemoSearchResults([...baseFiltered, ...extraMods], showIncompatibleResults);
}

export function useModsWorkspace(inputs: ModsWorkspaceInputs) {
  const {
    activeServer, activePage, activeServerIsDemo, activeServerUsesInternalNode, activeNodeRuntimeBlocked,
    activeNodeBlockMessage, demoMode, demoInstalledMods, setDemoInstalledMods, modrinthConfigured,
    isProvisioning, canManage, modsLocked, toggleLocked, notify, setNotice,
    setActiveJobs, handleStaleSession, refreshFiles
  } = inputs;
  const demoFixture = readModsDemoFixture();

  const [installedMods, setInstalledMods] = useState<InstalledMod[]>([]);
  const [modsLoading, setModsLoading] = useState(false);
  const [modsError, setModsError] = useState("");
  const [installedQuery, setInstalledQuery] = useState("");
  const [detailsModKey, setDetailsModKey] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [showIncompatibleResults, setShowIncompatibleResults] = useState(false);
  const [searchRequestVersion, setSearchRequestVersion] = useState(0);
  const [searchResults, setSearchResults] = useState<ModrinthHit[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [installState, setInstallState] = useState<ModInstallModalState | null>(null);
  const [updatePlan, setUpdatePlan] = useState<ModUpdatePlan | null>(null);
  const [updatePlanLoading, setUpdatePlanLoading] = useState(false);
  const [updatePlanError, setUpdatePlanError] = useState("");
  const [batchUpdateRunning, setBatchUpdateRunning] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const activeServerIdRef = useRef("");
  const loadMoreInFlightRef = useRef(false);
  const refreshUpdatesInFlightRef = useRef(false);
  const toggleQueueRef = useRef<Record<string, { targetEnabled: boolean; inFlightEnabled: boolean | null }>>({});

  useEffect(() => {
    activeServerIdRef.current = activeServer?.id ?? "";
  }, [activeServer?.id]);

  const detailsMod = useMemo(() => installedMods.find((mod) => installedModKey(mod) === detailsModKey) ?? null, [detailsModKey, installedMods]);
  const selectedVersion = useMemo(() => {
    if (!installState?.data || !installState.selectedVersionId) return null;
    return [...installState.data.compatibleVersions, ...installState.data.otherVersions].find((version) => version.id === installState.selectedVersionId) ?? null;
  }, [installState?.data, installState?.selectedVersionId]);
  const pendingDependencies = useMemo(() => activeServerUsesInternalNode ? pendingRequiredDependencies(selectedVersion, installedMods) : [], [activeServerUsesInternalNode, installedMods, selectedVersion]);
  const canContinueInstall = Boolean(
    selectedVersion
    && selectedVersion.selectable
    && (
      getInstallVersionHealth(selectedVersion).safeToRunDirectly
      || (installState?.showOtherVersions && getInstallVersionHealth(selectedVersion).requiresAcknowledgement && installState.acknowledgeMinecraftMismatch)
    )
  );

  async function loadInstalledMods(serverId = activeServer?.id, options: { forceRefresh?: boolean; notifyOnError?: boolean } = {}) {
    if (!serverId || isProvisioning) return;
    setModsLoading(true);
    setModsError("");
    if (activeServerIsDemo || (demoMode && serverId === demoServerId)) {
      if (activeServerIdRef.current === serverId) setInstalledMods(demoInstalledMods);
      setModsLoading(false);
      return;
    }
    try {
      const result = await api<{ mods: InstalledMod[] }>(`/api/servers/${serverId}/mods${options.forceRefresh ? "?forceRefresh=true" : ""}`);
      if (activeServerIdRef.current === serverId) {
        setInstalledMods((current) => mergeStableModMetadata(current, result.mods));
        setModsError("");
      }
    } catch (error) {
      if (handleStaleSession(error)) return;
      const message = errorMessage(error, "Could not load installed mods. Check the server mods folder and retry.");
      setModsError(message);
      if (options.notifyOnError) {
        setNotice(message);
        notify("error", message);
      }
    } finally {
      if (activeServerIdRef.current === serverId) setModsLoading(false);
    }
  }

  async function loadUpdatePlan(serverId = activeServer?.id, options: { forceRefresh?: boolean; notifyOnError?: boolean } = {}) {
    if (!serverId || isProvisioning) return null;
    setUpdatePlanLoading(true);
    setUpdatePlanError("");
    if (activeServerIsDemo || (demoMode && serverId === demoServerId)) {
      const fixtureError = demoFixtureFailureMessage(demoFixture, "update-plan");
      if (fixtureError) {
        if (activeServerIdRef.current === serverId) {
          setUpdatePlan(null);
          setUpdatePlanError(fixtureError);
        }
        setUpdatePlanLoading(false);
        return null;
      }
      const plan = createDemoUpdatePlan(serverId, demoInstalledMods);
      if (activeServerIdRef.current === serverId) setUpdatePlan(plan);
      setUpdatePlanLoading(false);
      return plan;
    }
    try {
      const plan = await api<ModUpdatePlan>(`/api/servers/${serverId}/mods/update-plan${options.forceRefresh ? "?forceRefresh=true" : ""}`);
      if (activeServerIdRef.current === serverId) setUpdatePlan(plan);
      return plan;
    } catch (error) {
      if (handleStaleSession(error)) return null;
      const message = errorMessage(error, "Could not build the mod update plan.");
      setUpdatePlanError(message);
      if (options.notifyOnError) notify("error", message);
      return null;
    } finally {
      if (activeServerIdRef.current === serverId) setUpdatePlanLoading(false);
    }
  }

  async function refreshUpdates(forceRefresh = true, notifyOnError = forceRefresh) {
    if (refreshUpdatesInFlightRef.current) return;
    refreshUpdatesInFlightRef.current = true;
    try {
      await Promise.all([
        loadInstalledMods(activeServer?.id, { forceRefresh, notifyOnError }),
        loadUpdatePlan(activeServer?.id, { forceRefresh, notifyOnError })
      ]);
    } finally {
      refreshUpdatesInFlightRef.current = false;
    }
  }

  async function refreshModsWorkspace(serverId: string, options: { forceRefresh?: boolean; notifyOnError?: boolean } = {}) {
    await Promise.all([
      loadInstalledMods(serverId, options),
      loadUpdatePlan(serverId, options),
      refreshFiles(serverId, "/mods")
    ]);
  }

  async function retrySidebarRequest<T>(request: () => Promise<T>, signal?: AbortSignal) {
    try {
      return await request();
    } catch (error) {
      if (handleStaleSession(error) || !shouldRetryModrinthError(error)) throw error;
      await waitForRetry(signal);
      return request();
    }
  }

  function resetPageState() {
    setAddOpen(false);
    setQuery("");
    setDebouncedQuery("");
    setShowIncompatibleResults(false);
    setSearchRequestVersion((current) => current + 1);
    setSearchResults([]);
    setSearchTotal(0);
    setSearchError("");
    setSearching(false);
    setLoadingMore(false);
    setInstallState(null);
    setDetailsModKey("");
    setInstalledQuery("");
    loadMoreInFlightRef.current = false;
  }

  useEffect(() => {
    resetPageState();
    toggleQueueRef.current = {};
    if (!activeServer) {
      setInstalledMods([]);
      setUpdatePlan(null);
      setUpdatePlanError("");
      setModsError("");
      setModsLoading(false);
      return;
    }
    if (activeNodeRuntimeBlocked) {
      setModsError(activeNodeBlockMessage);
      setModsLoading(false);
      setInstalledMods([]);
      setUpdatePlan(null);
      setUpdatePlanError(activeNodeBlockMessage);
      return;
    }
    void refreshUpdates(false);
  }, [activeServer?.id, activeNodeRuntimeBlocked, activeNodeBlockMessage]);

  useEffect(() => {
    if (activeServerIsDemo) {
      setInstalledMods(demoInstalledMods);
      if (activeServer) setUpdatePlan(createDemoUpdatePlan(activeServer.id, demoInstalledMods));
    }
  }, [activeServerIsDemo, demoInstalledMods]);

  useEffect(() => {
    resetPageState();
  }, [activePage]);

  useEffect(() => {
    if (!activeServer || activeNodeRuntimeBlocked || activePage !== "mods" || !addOpen || !modrinthConfigured) {
      setDebouncedQuery("");
      setSearching(false);
      return;
    }
    const trimmedQuery = query.trim();
    setInstallState(null);
    setSearchError("");
    if (!trimmedQuery) {
      setDebouncedQuery("");
      setSearchResults([]);
      setSearchTotal(0);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timeout = window.setTimeout(() => setDebouncedQuery(trimmedQuery), modSearchDebounceMs);
    return () => window.clearTimeout(timeout);
  }, [activeServer?.id, activeNodeRuntimeBlocked, activePage, addOpen, modrinthConfigured, query]);

  function updateShowIncompatibleResults(value: boolean) {
    setShowIncompatibleResults(value);
    setSearchResults([]);
    setSearchTotal(0);
    setSearchError("");
    setLoadingMore(false);
    loadMoreInFlightRef.current = false;
    setInstallState(null);
    if (query.trim()) setSearching(true);
    setSearchRequestVersion((current) => current + 1);
  }

  useEffect(() => {
    if (!activeServer || activeNodeRuntimeBlocked || activePage !== "mods" || !addOpen || !modrinthConfigured) return;
    const trimmedQuery = debouncedQuery.trim();
    if (!trimmedQuery) return;
    setSearchResults([]);
    setSearchTotal(0);
    setSearchError("");
    setLoadingMore(false);
    loadMoreInFlightRef.current = false;
    if (activeServerIsDemo) {
      setSearching(true);
      const timeout = window.setTimeout(() => {
        const fixtureError = demoFixtureFailureMessage(demoFixture, "search");
        if (fixtureError) {
          setSearchError(fixtureError);
          setSearching(false);
          return;
        }
        const results = demoSearchPage(trimmedQuery, showIncompatibleResults);
        setSearchResults(results.slice(0, 20));
        setSearchTotal(results.length);
        setSearching(false);
      }, 250);
      return () => { setSearching(false); window.clearTimeout(timeout); };
    }
    let cancelled = false;
    const abortController = new AbortController();
    setSearching(true);
    void retrySidebarRequest(
      () => api<{ hits: ModrinthHit[]; total_hits: number }>(
        buildModrinthSearchPath({ query: trimmedQuery, serverId: activeServer.id, showIncompatibleResults }),
        { signal: abortController.signal }
      ),
      abortController.signal
    ).then((result) => {
      if (!cancelled) {
        setSearchResults(result.hits);
        setSearchTotal(result.total_hits ?? 0);
      }
    }).catch((error) => {
      if (cancelled || abortController.signal.aborted) return;
      if (handleStaleSession(error)) return;
      const message = errorMessage(error, "Could not search Modrinth. Check the API key and network availability.");
      setSearchError(message);
    }).finally(() => { if (!cancelled) setSearching(false); });
    return () => { cancelled = true; abortController.abort(); };
  }, [activeServer?.id, activeNodeRuntimeBlocked, activePage, addOpen, modrinthConfigured, debouncedQuery, searchRequestVersion, activeServerIsDemo, showIncompatibleResults]);

  async function loadMoreMods() {
    if (loadMoreInFlightRef.current || loadingMore || searching || !activeServer) return;
    const offset = searchResults.length;
    if (offset >= searchTotal) return;
    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    const searchQuery = query.trim();
    if (activeServerIsDemo) {
      window.setTimeout(() => {
        const results = demoSearchPage(searchQuery, showIncompatibleResults);
        setSearchResults((current) => [...current, ...results.slice(offset, offset + 20)]);
        loadMoreInFlightRef.current = false;
        setLoadingMore(false);
      }, 250);
      return;
    }
    try {
      const result = await retrySidebarRequest(() => api<{ hits: ModrinthHit[]; total_hits: number }>(buildModrinthSearchPath({ query: searchQuery, serverId: activeServer.id, showIncompatibleResults, offset, limit: 20 })));
      setSearchResults((current) => [...current, ...result.hits]);
    } catch (error) {
      if (handleStaleSession(error)) return;
      setSearchError(errorMessage(error, "Could not load more search results."));
    } finally {
      loadMoreInFlightRef.current = false;
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loadingMore && !searching && searchResults.length < searchTotal) void loadMoreMods();
    }, { rootMargin: "200px" });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [searchResults.length, searchTotal, loadingMore, searching, query, showIncompatibleResults]);

  async function loadInstallVersions(mod: ModrinthHit, channel: ReleaseChannel, options: { useFallbackChannel?: boolean } = {}) {
    if (!activeServer) return;
    setInstallState((current) => current?.mod.project_id === mod.project_id ? { ...current, channel, loading: true, installing: false, error: "", step: 1, acknowledgeMinecraftMismatch: false, selectedVersionId: "", data: current.channel === channel ? current.data : null } : current);
    try {
      const fetchVersions = async (nextChannel: ReleaseChannel) => {
        if (!activeServerIsDemo) {
          return retrySidebarRequest(() => api<ModrinthInstallVersionsResponse>(`/api/modrinth/projects/${encodeURIComponent(mod.project_id)}/versions?serverId=${encodeURIComponent(activeServer.id)}&channel=${encodeURIComponent(nextChannel)}`));
        }
        const fixtureError = demoFixtureFailureMessage(demoFixture, "versions");
        if (fixtureError) throw new Error(fixtureError);
        return demoInstallVersions(activeServer, mod, nextChannel);
      };
      let resolvedChannel = channel;
      let data = await fetchVersions(resolvedChannel);
      while (options.useFallbackChannel && !hasInstallVersions(data)) {
        const fallback = fallbackReleaseChannel(resolvedChannel);
        if (!fallback) break;
        resolvedChannel = fallback;
        data = await fetchVersions(resolvedChannel);
      }
      setInstallState((current) => current?.mod.project_id === mod.project_id ? { ...current, channel: resolvedChannel, loading: false, installing: false, error: "", data, selectedVersionId: preferredInstallVersionId(data), acknowledgeMinecraftMismatch: false } : current);
    } catch (error) {
      if (handleStaleSession(error)) return;
      const message = errorMessage(error, "Could not load Modrinth versions for this project.");
      setInstallState((current) => current?.mod.project_id === mod.project_id ? { ...current, channel, loading: false, installing: false, error: message, data: null, selectedVersionId: "" } : current);
    }
  }

  function openInstallReview(mod: ModrinthHit) {
    const channel: ReleaseChannel = "release";
    setInstallState({ mod, step: 1, channel, loading: true, installing: false, error: "", data: null, selectedVersionId: "", showOtherVersions: false, acknowledgeMinecraftMismatch: false });
    void loadInstallVersions(mod, channel, { useFallbackChannel: true });
  }

  function selectInstallVersion(version: ModrinthInstallVersion) {
    if (!version.selectable) return;
    setInstallState((current) => current ? { ...current, selectedVersionId: version.id, acknowledgeMinecraftMismatch: getInstallVersionHealth(version).requiresAcknowledgement ? current.acknowledgeMinecraftMismatch : false } : current);
  }

  function continueInstallReview() {
    if (!installState || !selectedVersion || !canContinueInstall) return;
    setInstallState((current) => current ? { ...current, step: 2 } : current);
  }

  function patchJob(id: string, patch: Partial<GeneralJob>) {
    setActiveJobs((current) => current.map((job) => job.id === id ? { ...job, ...patch } : job));
  }

  function removeJob(id: string) {
    setActiveJobs((current) => current.filter((job) => job.id !== id));
  }

  async function uploadMod(event: ChangeEvent<HTMLInputElement>) {
    if (modsLocked || !canManage || !activeServer) return;
    const file = event.target.files?.[0];
    event.target.value = "";
    const selection = validateModUploadSelection(file, installedMods);
    if (!file || selection.kind === "cancelled") return;
    if (selection.kind === "error") { notify("error", selection.message); return; }
    setNotice("");
    const jobId = `upload-${file.name}-${Date.now()}`;
    setActiveJobs((current) => [...current, { id: jobId, type: "mod-upload", status: "running", title: "Uploading mod", subject: file.name, progress: 10, task: "Reading file", dismissible: false }]);
    if (activeServerIsDemo) {
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 500)); patchJob(jobId, { progress: 40, task: "Uploading jar" });
        await new Promise((resolve) => window.setTimeout(resolve, 800)); patchJob(jobId, { progress: 70, task: "Saving mod file" });
        await new Promise((resolve) => window.setTimeout(resolve, 400)); patchJob(jobId, { progress: 95, task: "Refreshing installed mods" });
        const mod = uploadedManualMod(file);
        setDemoInstalledMods((current) => [mod, ...current.filter((candidate) => candidate.filename !== mod.filename)]);
        setInstalledMods((current) => [mod, ...current.filter((candidate) => candidate.filename !== mod.filename)]);
        removeJob(jobId); notify("success", `Uploaded ${file.name}`);
      } catch (error) {
        patchJob(jobId, { status: "failed", task: "Upload failed", error: (error as Error).message, dismissible: true });
      }
      return;
    }
    try {
      const content = bufferToBase64(await file.arrayBuffer());
      patchJob(jobId, { progress: 40, task: "Uploading jar" });
      await api(`/api/servers/${activeServer.id}/mods/upload`, { method: "POST", body: JSON.stringify({ filename: file.name, contentBase64: content }) });
      patchJob(jobId, { progress: 90, task: "Refreshing installed mods" });
      try {
        await refreshModsWorkspace(activeServer.id, { forceRefresh: true });
        removeJob(jobId); notify("success", `Uploaded ${file.name}`);
      } catch (error) {
        patchJob(jobId, { status: "succeeded", progress: 100, task: `Uploaded ${file.name}, but failed to refresh mod list`, error: (error as Error).message, dismissible: true });
      }
      window.setTimeout(() => removeJob(jobId), 4000);
    } catch (error) {
      const message = (error as Error).message;
      setNotice(message); notify("error", message); patchJob(jobId, { status: "failed", task: "Upload failed", error: message, dismissible: true });
    } finally {
      setSearching(false);
    }
  }

  async function installSelectedMod() {
    if (modsLocked || !canManage || !activeServer || !installState?.data || !selectedVersion?.selectable) return;
    const projectId = installState.mod.project_id;
    const title = installState.data.project.title || installState.mod.title;
    const { forceIncompatible, overrideMinecraftVersion } = selectedInstallFlags(selectedVersion);
    if (getInstallVersionHealth(selectedVersion).requiresAcknowledgement && !installState.acknowledgeMinecraftMismatch) return;
    setNotice("");
    setInstallState((current) => current ? { ...current, installing: true, error: "" } : current);
    const jobId = `install-${projectId}-${selectedVersion.id}-${Date.now()}`;
    setActiveJobs((current) => [...current, { id: jobId, type: "mod-install", status: "running", title: "Installing mod", subject: `${title} ${selectedVersion.versionNumber}`, progress: 10, task: "Resolving version", dismissible: false }]);
    if (activeServerIsDemo) {
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 600)); patchJob(jobId, { progress: 40, task: "Resolving version" });
        await new Promise((resolve) => window.setTimeout(resolve, 800)); patchJob(jobId, { progress: 70, task: "Downloading jar" });
        await new Promise((resolve) => window.setTimeout(resolve, 600)); patchJob(jobId, { progress: 90, task: "Saving mod file" });
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        const filename = selectedVersion.file?.filename || `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || projectId}-demo.jar`;
        const mod: InstalledMod = {
          filename, displayName: title, enabled: true, size: selectedVersion.file?.size ?? 1_048_576, modifiedAt: new Date().toISOString(),
          iconUrl: installState.data.project.iconUrl || installState.mod.icon_url, description: installState.data.project.description || installState.mod.description,
          modrinth: {
            projectId, versionId: selectedVersion.id, filename, versionNumber: selectedVersion.versionNumber, versionType: selectedVersion.releaseChannel,
            gameVersions: selectedVersion.minecraftVersions, loaders: selectedVersion.loaders, hashes: selectedVersion.file?.hashes, installedAt: new Date().toISOString(),
            installedWithForceIncompatible: forceIncompatible, incompatibilityReason: forceIncompatible ? selectedVersion.reason : undefined,
            overrideMinecraftVersion, overrideReason: overrideMinecraftVersion ? selectedVersion.reason : undefined,
            clientSide: installState.data.project.clientSide, serverSide: installState.data.project.serverSide, forceIncompatible
          }
        };
        setDemoInstalledMods((current) => [mod, ...current.filter((candidate) => candidate.filename !== filename)]);
        setInstalledMods((current) => [mod, ...current.filter((candidate) => candidate.filename !== filename)]);
        removeJob(jobId); notify("success", `Installed ${title}`); setInstallState(null);
      } catch (error) {
        const message = (error as Error).message;
        patchJob(jobId, { status: "failed", task: "Install failed", error: message, dismissible: true });
        setInstallState((current) => current ? { ...current, installing: false, error: message } : current);
      }
      return;
    }
    try {
      patchJob(jobId, { progress: 35, task: "Downloading jar" });
      const result = await api<{ installed?: Array<{ filename: string; dependencyType: "root" | "required" }> }>("/api/modrinth/install", {
        method: "POST", body: JSON.stringify({ serverId: activeServer.id, projectId, versionId: selectedVersion.id, channel: installState.channel, forceIncompatible, overrideMinecraftVersion })
      });
      setInstallState(null);
      patchJob(jobId, { progress: 90, task: "Refreshing installed mods" });
      try {
        await refreshModsWorkspace(activeServer.id, { forceRefresh: true });
        const requiredCount = result.installed?.filter((item) => item.dependencyType === "required").length ?? 0;
        removeJob(jobId);
        notify("success", requiredCount ? `Installed ${title} and ${requiredCount} required ${requiredCount === 1 ? "dependency" : "dependencies"}` : `Installed ${title}`);
      } catch (error) {
        patchJob(jobId, { status: "succeeded", progress: 100, task: `Installed ${title}, but failed to refresh mod list`, error: (error as Error).message, dismissible: true });
      }
      window.setTimeout(() => removeJob(jobId), 4000);
    } catch (error) {
      const message = (error as Error).message;
      setNotice(message); notify("error", message); patchJob(jobId, { status: "failed", task: "Install failed", error: message, dismissible: true });
      setInstallState((current) => current ? { ...current, installing: false, error: message } : current);
      void refreshUpdates(true); void refreshFiles(activeServer.id, "/mods");
    }
  }

  async function updateMod(mod: InstalledMod) {
    if (modsLocked || !canManage || !activeServer || !mod.modrinth) return;
    setNotice("");
    const title = mod.displayName;
    const oldFilename = mod.filename;
    const plannedChannel = updatePlan?.updates.find((entry) => entry.filename === mod.filename)?.channel;
    const jobId = `update-${mod.modrinth.projectId}-${Date.now()}`;
    setActiveJobs((current) => [...current, { id: jobId, type: "mod-install", status: "running", title: "Updating mod", subject: title, progress: 10, task: "Checking compatibility", dismissible: false }]);
    if (activeServerIsDemo) {
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 600)); patchJob(jobId, { progress: 45, task: "Downloading update" });
        await new Promise((resolve) => window.setTimeout(resolve, 800)); patchJob(jobId, { progress: 80, task: "Removing old jar" });
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        const version = mod.versionInfo?.latestVersion || "0.6.0";
        const filename = mod.versionInfo?.latestFilename || oldFilename.replace(mod.modrinth.versionNumber, version);
        const updated: InstalledMod = { ...mod, filename, modifiedAt: new Date().toISOString(), versionInfo: { ...mod.versionInfo, currentVersion: version, latestVersion: version, upToDate: true }, modrinth: { ...mod.modrinth, filename, versionNumber: version, installedAt: new Date().toISOString() } };
        setDemoInstalledMods((current) => [updated, ...current.filter((candidate) => candidate.filename !== oldFilename)]);
        setInstalledMods((current) => [updated, ...current.filter((candidate) => candidate.filename !== oldFilename)]);
        notify("success", `Updated ${title} to ${version}`); patchJob(jobId, { status: "succeeded", progress: 100, task: `Updated ${title}`, dismissible: true });
        window.setTimeout(() => removeJob(jobId), 4000);
      } catch (error) {
        patchJob(jobId, { status: "failed", task: "Update failed", error: (error as Error).message, dismissible: true });
      }
      return;
    }
    try {
      patchJob(jobId, { progress: 30, task: "Downloading new version" });
      const result = await api<{ version: string; upToDate?: boolean }>("/api/modrinth/update", { method: "POST", body: JSON.stringify({ serverId: activeServer.id, filename: oldFilename, channel: plannedChannel || mod.preferredChannel || "release" }) });
      notify("success", result.upToDate ? `${title} is already up to date` : `Updated ${title} to ${result.version}`);
      patchJob(jobId, { progress: 90, task: "Refreshing installed mods" });
      try {
        await refreshModsWorkspace(activeServer.id, { forceRefresh: true });
        patchJob(jobId, { status: "succeeded", progress: 100, task: `Updated ${title}`, dismissible: true });
      } catch (error) {
        patchJob(jobId, { status: "succeeded", progress: 100, task: `Updated ${title}, but failed to refresh mod list`, error: (error as Error).message, dismissible: true });
      }
      window.setTimeout(() => removeJob(jobId), 4000);
    } catch (error) {
      const message = (error as Error).message;
      setNotice(message); notify("error", message); patchJob(jobId, { status: "failed", task: "Update failed", error: message, dismissible: true });
      void refreshUpdates(true); void refreshFiles(activeServer.id, "/mods");
    }
  }

  async function updateAllSafe() {
    if (modsLocked || !canManage || !activeServer || batchUpdateRunning) return;
    const plan = updatePlan ?? await loadUpdatePlan(activeServer.id, { forceRefresh: true });
    const safeEntries = plan?.updates.filter((entry) => entry.status === "safe_update" && entry.safeBatchEligible) ?? [];
    if (!safeEntries.length) {
      notify("info", "No safe mod updates are available.");
      return;
    }
    setBatchUpdateRunning(true);
    setNotice("");
    const jobId = `update-safe-${activeServer.id}-${Date.now()}`;
    setActiveJobs((current) => [...current, { id: jobId, type: "mod-install", status: "running", title: "Updating safe mods", subject: `${safeEntries.length} ${safeEntries.length === 1 ? "mod" : "mods"}`, progress: 10, task: "Validating update plan", dismissible: false }]);
    try {
      let result: SafeBatchUpdateResult;
      if (activeServerIsDemo) {
        patchJob(jobId, { progress: 45, task: "Applying safe updates" });
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        const safeByFilename = new Map(safeEntries.map((entry) => [entry.filename, entry]));
        const apply = (mods: InstalledMod[]) => mods.map((mod) => {
          const entry = safeByFilename.get(mod.filename);
          if (!entry || !mod.modrinth || !entry.targetVersion) return mod;
          const filename = entry.targetFilename || mod.filename.replace(mod.modrinth.versionNumber, entry.targetVersion);
          return {
            ...mod,
            filename,
            modifiedAt: new Date().toISOString(),
            versionInfo: { ...mod.versionInfo, currentVersion: entry.targetVersion, latestVersion: entry.targetVersion, latestFilename: filename, upToDate: true },
            modrinth: { ...mod.modrinth, filename, versionNumber: entry.targetVersion, installedAt: new Date().toISOString() }
          };
        });
        setDemoInstalledMods(apply);
        setInstalledMods(apply);
        result = {
          updated: safeEntries.map((entry) => ({ filename: entry.filename, result: { ok: true, version: entry.targetVersion } })),
          skipped: [],
          failed: [],
          counts: { requested: safeEntries.length, updated: safeEntries.length, skipped: 0, failed: 0 }
        };
      } else {
        patchJob(jobId, { progress: 35, task: "Applying safe updates" });
        const requests = safeUpdateRequestGroups(plan);
        const results: SafeBatchUpdateResult[] = [];
        for (const request of requests) {
          results.push(await api<SafeBatchUpdateResult>("/api/modrinth/update-safe", {
            method: "POST",
            body: JSON.stringify({ serverId: activeServer.id, filenames: request.filenames, channel: request.channel })
          }));
        }
        result = mergeSafeBatchUpdateResults(results);
      }
      patchJob(jobId, { progress: 85, task: "Refreshing update plan" });
      await refreshModsWorkspace(activeServer.id, { forceRefresh: true });
      const feedback = safeBatchUpdateFeedback(result);
      const issueDetails = [
        ...result.skipped.map((entry) => `${entry.filename} skipped: ${entry.reason}`),
        ...result.failed.map((entry) => `${entry.filename} failed: ${entry.reason}`)
      ].join("; ");
      patchJob(jobId, { status: feedback.status, title: feedback.title, progress: 100, task: feedback.summary, error: issueDetails || undefined, dismissible: true });
      window.setTimeout(() => removeJob(jobId), 5000);
    } catch (error) {
      const message = errorMessage(error, "Safe mod updates failed.");
      setNotice(message); notify("error", message); patchJob(jobId, { status: "failed", task: "Safe updates failed", error: message, dismissible: true });
      void refreshUpdates(true);
    } finally {
      setBatchUpdateRunning(false);
    }
  }

  async function processToggleQueue(filename: string, displayName: string) {
    const item = toggleQueueRef.current[filename];
    if (!item || item.inFlightEnabled !== null) return;
    let currentFilename = filename;
    while (true) {
      const runEnabled = item.targetEnabled;
      item.inFlightEnabled = runEnabled;
      if (activeServerIsDemo) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      } else if (activeServer) {
        try {
          const result = await api<{ filename: string; enabled: boolean }>(`/api/servers/${activeServer.id}/mods`, { method: "PATCH", body: JSON.stringify({ filename: currentFilename, enabled: runEnabled }) });
          const nextFilename = result.filename || currentFilename;
          setInstalledMods((current) => current.map((mod) => mod.filename === currentFilename ? { ...mod, filename: nextFilename, displayName: nextFilename.replace(/\.jar\.disabled$/, ".jar"), enabled: result.enabled } : mod));
          currentFilename = nextFilename;
          void refreshFiles(activeServer.id, "/mods");
        } catch (error) {
          const message = `Failed to toggle mod ${displayName}: ${(error as Error).message}`;
          setNotice(message); notify("error", message);
          const rollback = !runEnabled;
          setInstalledMods((current) => current.map((mod) => mod.filename === currentFilename ? { ...mod, enabled: rollback } : mod));
          if (demoMode) setDemoInstalledMods((current) => current.map((mod) => mod.filename === currentFilename ? { ...mod, enabled: rollback } : mod));
          break;
        }
      }
      item.inFlightEnabled = null;
      if (item.targetEnabled === runEnabled) break;
    }
    delete toggleQueueRef.current[filename];
    if (activeServer && !activeServerIsDemo) void loadInstalledMods(activeServer.id);
  }

  function setInstalledModEnabled(mod: InstalledMod, enabled: boolean) {
    if (toggleLocked || !canManage || !activeServer) return;
    setNotice("");
    setInstalledMods((current) => current.map((candidate) => candidate.filename === mod.filename ? { ...candidate, enabled } : candidate));
    setUpdatePlan((current) => current ? { ...current, updates: current.updates.map((entry) => entry.filename === mod.filename ? { ...entry, enabled } : entry) } : current);
    if (demoMode) setDemoInstalledMods((current) => current.map((candidate) => candidate.filename === mod.filename ? { ...candidate, enabled } : candidate));
    const queued = toggleQueueRef.current[mod.filename];
    if (queued) queued.targetEnabled = enabled;
    else toggleQueueRef.current[mod.filename] = { targetEnabled: enabled, inFlightEnabled: null };
    void processToggleQueue(mod.filename, mod.displayName);
  }

  async function removeMod(mod: InstalledMod) {
    if (modsLocked || !canManage || !activeServer) return;
    setNotice("");
    if (!window.confirm(`Remove ${mod.displayName}?\n\nThis deletes ${mod.filename} from the server's mods folder.`)) return;
    if (activeServerIsDemo) {
      setDemoInstalledMods((current) => current.filter((candidate) => candidate.filename !== mod.filename));
      setInstalledMods((current) => current.filter((candidate) => candidate.filename !== mod.filename));
      setDetailsModKey(""); notify("success", `Removed ${mod.displayName}`); return;
    }
    try {
      await api(`/api/servers/${activeServer.id}/mods?filename=${encodeURIComponent(mod.filename)}`, { method: "DELETE" });
      notify("success", `Removed ${mod.displayName}`); setDetailsModKey("");
      await refreshModsWorkspace(activeServer.id, { forceRefresh: true });
    } catch (error) {
      const message = errorMessage(error, "Could not remove the mod.");
      setNotice(message); notify("error", message);
    }
  }

  return {
    data: { installedMods, searchResults, searchTotal, updatePlan },
    state: { modsLoading, modsError, installedQuery, detailsMod, addOpen, query, showIncompatibleResults, searching, loadingMore, searchError, installState, updatePlanLoading, updatePlanError, batchUpdateRunning },
    derived: { selectedVersion, pendingDependencies, canContinueInstall },
    refs: { sentinelRef },
    actions: {
      setInstalledQuery, setDetailsMod: (mod: InstalledMod | null) => setDetailsModKey(mod ? installedModKey(mod) : ""), setQuery, setInstallState,
      openAdd: () => { setDetailsModKey(""); setAddOpen(true); },
      closeAdd: () => { setInstallState(null); setQuery(""); setDebouncedQuery(""); setShowIncompatibleResults(false); setSearchResults([]); setSearchTotal(0); setSearchError(""); setLoadingMore(false); loadMoreInFlightRef.current = false; setAddOpen(false); },
      refresh: refreshUpdates,
      retry: () => loadInstalledMods(activeServer?.id),
      retrySearch: () => setSearchRequestVersion((current) => current + 1),
      setShowIncompatibleResults: updateShowIncompatibleResults,
      loadInstallVersions, openInstallReview, selectInstallVersion, continueInstallReview,
      backInstall: () => setInstallState((current) => current ? { ...current, step: 1, installing: false } : current),
      closeInstall: () => setInstallState(null),
      toggleAdvanced: () => setInstallState((current) => {
        if (!current) return current;
        const showOtherVersions = !current.showOtherVersions;
        return { ...current, showOtherVersions, selectedVersionId: showOtherVersions ? current.selectedVersionId : current.data ? preferredInstallVersionId(current.data) : "", acknowledgeMinecraftMismatch: false };
      }),
      acknowledgeInstall: (checked: boolean) => setInstallState((current) => current ? { ...current, acknowledgeMinecraftMismatch: checked } : current),
      uploadMod, installSelectedMod, updateMod, updateAllSafe, setInstalledModEnabled, removeMod, resetPageState
    }
  };
}
