import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ContextNode, FabricVersions, ManagedServer, RuntimeLoaderVersion, RuntimeMinecraftVersion, RuntimeResolveResponse, ServerRuntimeProfile } from '../types';
import { defaultDockerImageForMinecraftVersion, defaultQueryPort, defaultServerPort, fabricLoaderVersionInfo, isValidServerPort, maxServerPort, memoryArgs, minecraftVersionInfo, minServerPort, parseJavaMemoryArgs, parseMaxMemoryGb, replaceMemoryArgs, totalMemoryGb, versionSourceLabel, versionValue } from '../utils/format';
import { isNodeRuntimeUsable, nodeBlockReason } from '../utils/nodes';
import { AppIcon } from '../components/FileTypeIcon';

function jarProviderLabel(provider?: string) {
  if (provider === "mcjars") return "MCJars";
  return "Unknown";
}

function runtimeStatusLabel(status?: string) {
  if (status === "compatible") return "Compatible";
  if (status === "unsupported") return "Unsupported";
  return "Unknown";
}

type PortBindingRow = {
  id: string;
  hostPort: string;
  target: string;
};

function portBindingId() {
  return `port-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeDefaultPort(value: string) {
  return isValidServerPort(value) ? value : String(defaultServerPort);
}

function normalizeQueryPort(value: string) {
  return isValidServerPort(value) ? value : String(defaultQueryPort);
}

function parsePortBinding(binding: string) {
  const pieces = binding.split(":");
  const hostPort = pieces.length === 2 ? pieces[0].trim() : pieces[0].split("/", 1)[0].trim();
  const target = pieces.length === 2 ? pieces[1].trim() : pieces[0].trim();
  return {
    id: portBindingId(),
    hostPort,
    target: target.includes("/") ? target : `${target}/tcp`
  };
}

function parsePortBindings(value: string | undefined): PortBindingRow[] {
  return (value || "")
    .split(",")
    .map((rawBinding) => rawBinding.trim())
    .filter(Boolean)
    .map(parsePortBinding);
}

function parseDockerBindingPorts(value?: string) {
  const rows = parsePortBindings(value);
  const serverBinding = rows.find((row) => {
    const [containerPort, protocol = "tcp"] = row.target.split("/", 2);
    return protocol === "tcp" && (containerPort === row.hostPort || containerPort === String(defaultServerPort));
  });
  const queryBinding = rows.find((row) => {
    const [containerPort, protocol = "tcp"] = row.target.split("/", 2);
    return protocol === "udp" && (containerPort === row.hostPort || containerPort === String(defaultQueryPort));
  });
  return {
    serverPort: serverBinding?.hostPort && isValidServerPort(serverBinding.hostPort) ? serverBinding.hostPort : String(defaultServerPort),
    queryPort: queryBinding?.hostPort && isValidServerPort(queryBinding.hostPort) ? queryBinding.hostPort : String(defaultQueryPort)
  };
}

function queryPortForServer(server: ManagedServer) {
  const managed = server.managedPorts?.find((port) => port.type === "query")?.externalPort;
  if (managed && isValidServerPort(String(managed))) return String(managed);
  return parseDockerBindingPorts(server.dockerPorts).queryPort;
}

function serverPortForServer(server: ManagedServer) {
  return parseDockerBindingPorts(server.dockerPorts).serverPort;
}

function parseAdditionalPortBindings(value: string | undefined, serverPort: string, queryPort: string): PortBindingRow[] {
  const normalizedServerPort = normalizeDefaultPort(serverPort);
  const normalizedQueryPort = normalizeQueryPort(queryPort);
  return parsePortBindings(value).filter((row) => {
    const [containerPort, protocol = "tcp"] = row.target.split("/", 2);
    const isServerPort = row.hostPort === normalizedServerPort && containerPort === normalizedServerPort && protocol === "tcp";
    const isQueryPort = row.hostPort === normalizedQueryPort && containerPort === normalizedQueryPort && protocol === "udp";
    return !isServerPort && !isQueryPort;
  });
}

function formatAdditionalPortBindings(rows: PortBindingRow[]) {
  return rows
    .map((row) => ({ hostPort: row.hostPort.trim(), target: row.target.trim() }))
    .filter((row) => row.hostPort || row.target)
    .map((row) => `${row.hostPort}:${row.target}`)
    .join(",");
}

function formatManagedPortBindings(serverPort: string, queryPort: string, additionalRows: PortBindingRow[]) {
  const normalizedServerPort = normalizeDefaultPort(serverPort);
  const normalizedQueryPort = normalizeQueryPort(queryPort);
  return [
    `${normalizedServerPort}:${normalizedServerPort}/tcp`,
    `${normalizedQueryPort}:${normalizedQueryPort}/udp`,
    formatAdditionalPortBindings(additionalRows)
  ].filter(Boolean).join(",");
}

function AdditionalPortBindingsEditor({
  initialValue,
  serverPort,
  queryPort
}: {
  initialValue?: string;
  serverPort: string;
  queryPort: string;
}) {
  const [bindings, setBindings] = useState(() => parseAdditionalPortBindings(initialValue, serverPort, queryPort));
  const serializedBindings = formatManagedPortBindings(serverPort, queryPort, bindings);

  useEffect(() => {
    setBindings((current) => current.filter((row) => {
      const [containerPort, protocol = "tcp"] = row.target.split("/", 2);
      return !(row.hostPort === serverPort && containerPort === serverPort && protocol === "tcp")
        && !(row.hostPort === queryPort && containerPort === queryPort && protocol === "udp");
    }));
  }, [serverPort, queryPort]);

  function updateBinding(id: string, patch: Partial<PortBindingRow>) {
    setBindings((current) => current.map((binding) => binding.id === id ? { ...binding, ...patch } : binding));
  }

  function addBinding() {
    setBindings((current) => [...current, { id: portBindingId(), hostPort: "", target: "" }]);
  }

  function removeBinding(id: string) {
    setBindings((current) => current.filter((binding) => binding.id !== id));
  }

  return (
    <div className={`portBindingsEditor ${bindings.length > 1 ? "hasExtraBindings" : ""}`}>
      <span className="fieldLabel">Additional port bindings</span>
      <input type="hidden" name="dockerPorts" value={serializedBindings} />
      <div className="portBindingRows">
        {bindings.map((binding, index) => (
          <div key={binding.id} className="portBindingRow">
            <input
              type="text"
              inputMode="numeric"
              value={binding.hostPort}
              onChange={(event) => updateBinding(binding.id, { hostPort: event.target.value })}
              placeholder="24454"
              aria-label="Additional host port"
            />
            <span className="portBindingColon" aria-hidden="true">:</span>
            <input
              type="text"
              value={binding.target}
              onChange={(event) => updateBinding(binding.id, { target: event.target.value })}
              placeholder="24454/udp"
              aria-label="Additional container port and protocol"
            />
            <button
              type="button"
              className="iconDangerButton portBindingRemoveButton"
              onClick={() => removeBinding(binding.id)}
              aria-label="Remove port binding"
              title="Remove port binding"
            >
              <AppIcon name="trash" />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="secondaryButton portBindingAddButton" onClick={addBinding}>
        <AppIcon name="plus" />
        <span>Add port binding</span>
      </button>
      <span className="fieldHint">Use host port on the left and container port/protocol on the right, for example 24454 : 24454/udp.</span>
    </div>
  );
}

function MinecraftPortsSection({
  serverPort,
  queryPort,
  onServerPortChange,
  onQueryPortChange,
  serverPortValid,
  queryPortValid,
  portConflict
}: {
  serverPort: string;
  queryPort: string;
  onServerPortChange: (value: string) => void;
  onQueryPortChange: (value: string) => void;
  serverPortValid: boolean;
  queryPortValid: boolean;
  portConflict: boolean;
}) {
  return (
    <section className="minecraftPortsSection" aria-labelledby="minecraft-ports-title">
      <div className="placementHeader">
        <span>Ports</span>
        <h3 id="minecraft-ports-title">Minecraft network ports</h3>
      </div>
      <div className="minecraftPortsGrid">
        <label>
          Server port
          <input
            name="serverPort"
            type="number"
            min={minServerPort}
            max={maxServerPort}
            value={serverPort}
            onChange={(event) => onServerPortChange(event.target.value)}
            aria-invalid={!serverPortValid || portConflict}
            required
          />
          <span className="fieldHint">TCP port used by Minecraft clients.</span>
        </label>
        <label>
          Query port
          <input
            name="queryPort"
            type="number"
            min={minServerPort}
            max={maxServerPort}
            value={queryPort}
            onChange={(event) => onQueryPortChange(event.target.value)}
            aria-invalid={!queryPortValid || portConflict}
            required
          />
          <span className="fieldHint">UDP port used by ServerSentinel for quiet player metrics.</span>
        </label>
      </div>
      {!serverPortValid && <span className="fieldError">Use a server port from {minServerPort} to {maxServerPort}.</span>}
      {!queryPortValid && <span className="fieldError">Use a Query port from {minServerPort} to {maxServerPort}.</span>}
      {portConflict && <span className="fieldError">Server port and Query port must be different.</span>}
    </section>
  );
}

export function MemorySelector({
  totalMemory,
  initialMemoryGb = 4,
  javaArgs,
  onJavaArgsChange
}: {
  totalMemory: number;
  initialMemoryGb?: number;
  javaArgs: string;
  onJavaArgsChange: (value: string) => void;
}) {
  const totalRamGb = totalMemoryGb(totalMemory);
  const memoryInfo = parseJavaMemoryArgs(javaArgs);
  const sliderMode: "linked" | "maximum" = memoryInfo.xmsGb !== null && memoryInfo.xmxGb !== null && memoryInfo.xmsGb !== memoryInfo.xmxGb ? "maximum" : "linked";
  const parsedMemoryGb = memoryInfo.xmxGb ?? initialMemoryGb;
  const [memoryGb, setMemoryGb] = useState(() => Math.min(Math.max(1, parsedMemoryGb), totalRamGb));

  useEffect(() => {
    setMemoryGb(Math.min(Math.max(1, parsedMemoryGb), totalRamGb));
  }, [parsedMemoryGb, totalRamGb]);

  function updateMemory(value: number) {
    if (!Number.isFinite(value)) return;
    const nextMemoryGb = Math.min(Math.max(1, Math.round(value)), totalRamGb);
    setMemoryGb(nextMemoryGb);
    onJavaArgsChange(replaceMemoryArgs(javaArgs, nextMemoryGb, { updateInitialHeap: sliderMode === "linked" }));
  }

  return (
    <div className="memorySelector">
      <div className="memorySelectorHeader">
        <label htmlFor="memoryGb">Minecraft memory</label>
        <span className="totalRamLabel">{sliderMode === "linked" ? "Initial and maximum heap linked" : "Adjusting maximum heap"}</span>
      </div>
      <div className="memorySelectorControls">
        <input
          id="memoryGb"
          type="range"
          min="1"
          max={totalRamGb}
          value={memoryGb}
          onChange={(event) => updateMemory(Number(event.target.value))}
          className="memorySlider"
        />
        <div className="memoryInputWrap">
          <input
            type="number"
            min="1"
            max={totalRamGb}
            value={memoryGb}
            onChange={(event) => updateMemory(Number(event.target.value))}
            className="memoryNumberInput"
          />
          <span className="unit">GB</span>
        </div>
      </div>
      <p className="safelyAllocateTip">
        {memoryGb > totalRamGb * 0.8 ? (
          <span className="warn">Leave some RAM for the host. Using nearly all memory may cause instability.</span>
        ) : (
          <span className="ok">{sliderMode === "linked" ? `Writes -Xms${memoryGb}G and -Xmx${memoryGb}G.` : `Advanced args use a custom -Xms value, so the slider changes -Xmx${memoryGb}G only.`}</span>
        )}
      </p>
    </div>
  );
}

export function ServerEditForm({
  server,
  versions,
  totalMemory,
  onSubmit,
  disabled = false
}: {
  server: ManagedServer;
  versions: FabricVersions;
  totalMemory: number;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
}) {
  const [javaArgs, setJavaArgs] = useState(server.javaArgs || memoryArgs(parseMaxMemoryGb(server.javaArgs)));
  const [serverPort, setServerPort] = useState(() => serverPortForServer(server));
  const [queryPort, setQueryPort] = useState(() => queryPortForServer(server));
  const detectedMinecraftVersion = minecraftVersionInfo(server);
  const detectedFabricLoaderVersion = fabricLoaderVersionInfo(server);
  const serverPortValid = isValidServerPort(serverPort);
  const queryPortValid = isValidServerPort(queryPort);
  const portConflict = serverPort === queryPort;

  useEffect(() => {
    setServerPort(serverPortForServer(server));
    setQueryPort(queryPortForServer(server));
  }, [server.id, server.dockerPorts, server.managedPorts]);

  return (
    <form onSubmit={onSubmit} className="appForm">
      <fieldset disabled={disabled}>
      <label>
        Display name
        <input name="displayName" defaultValue={server.displayName} required maxLength={80} />
      </label>
      <label>
        Minecraft version
        <select name="minecraftVersion" defaultValue={server.minecraftVersion}>
          {versions.game.length ? versions.game.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          )) : <option value={server.minecraftVersion}>{server.minecraftVersion}</option>}
        </select>
        <span className="fieldHint">Current: {versionValue(detectedMinecraftVersion)} ({versionSourceLabel(detectedMinecraftVersion.source)})</span>
      </label>
      <label>
        Fabric loader version
        <select name="loaderVersion" defaultValue={server.loaderVersion ?? ""}>
          <option value="">Latest stable</option>
          {versions.loader.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          ))}
        </select>
        <span className="fieldHint">Current: {versionValue(detectedFabricLoaderVersion)} ({versionSourceLabel(detectedFabricLoaderVersion.source)})</span>
      </label>
      <label>
        Fabric installer version
        <select name="installerVersion" defaultValue={server.installerVersion ?? ""}>
          <option value="">Latest stable</option>
          {versions.installer.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          ))}
        </select>
      </label>
      <MemorySelector
        totalMemory={totalMemory}
        initialMemoryGb={parseMaxMemoryGb(javaArgs)}
        javaArgs={javaArgs}
        onJavaArgsChange={setJavaArgs}
      />
      <details className="advanced">
        <summary>Advanced Java arguments</summary>
        <label>
          Java arguments
          <textarea
            className="javaArgsInput"
            name="javaArgs"
            value={javaArgs}
            onChange={(event) => setJavaArgs(event.target.value)}
            rows={4}
            spellCheck={false}
          />
        </label>
        <p className="fieldHint">If -Xms and -Xmx differ, the memory slider adjusts -Xmx only and keeps your custom -Xms value.</p>
      </details>
      <label>
        Docker runtime image
        <select name="dockerImage" defaultValue={server.dockerImage || "eclipse-temurin:21-jre"}>
          <option value="eclipse-temurin:21-jre">Java 21 runtime</option>
          <option value="eclipse-temurin:17-jre">Java 17 runtime</option>
          <option value="eclipse-temurin:25-jre">Java 25 runtime</option>
        </select>
      </label>
      <label>
        Server jar filename
        <input name="serverJar" defaultValue={server.serverJar || "fabric-server-launch.jar"} pattern="^[^\\/]+\.jar$" title="Use a local .jar filename, not a path." />
      </label>
      <label>
        Docker container name
        <input name="dockerContainer" defaultValue={server.dockerContainer || ""} pattern="^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$" title="Use letters, numbers, dots, dashes, and underscores." />
      </label>
      <MinecraftPortsSection
        serverPort={serverPort}
        queryPort={queryPort}
        onServerPortChange={setServerPort}
        onQueryPortChange={setQueryPort}
        serverPortValid={serverPortValid}
        queryPortValid={queryPortValid}
        portConflict={portConflict}
      />
      <details className="advanced">
        <summary>Additional port bindings</summary>
        <AdditionalPortBindingsEditor key={server.id} initialValue={server.dockerPorts} serverPort={serverPort} queryPort={queryPort} />
      </details>
      <button disabled={!serverPortValid || !queryPortValid || portConflict}>Save server settings</button>
      </fieldset>
    </form>
  );
}

export function DeleteServerPanel({
  server,
  onSubmit,
  disabled = false
}: {
  server: ManagedServer;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
}) {
  const [confirmName, setConfirmName] = useState("");
  const deleteConfirmed = confirmName === server.displayName;

  useEffect(() => {
    setConfirmName("");
  }, [server.id]);

  return (
    <section className="panel dangerPanel">
      <h2>Delete Server</h2>
      <p className="muted">This removes the server from ServerSentinel. File deletion is optional and cannot be undone.</p>
      <form onSubmit={onSubmit} className="appForm">
        <fieldset disabled={disabled}>
        <label>
          Type server name to confirm
          <input
            name="confirmName"
            placeholder={server.displayName}
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            required
          />
        </label>
        <label className="checkLine dangerCheck">
          <input name="deleteFiles" type="checkbox" />
          Also delete this server's files from disk
        </label>
        <button className="dangerButton" disabled={!deleteConfirmed}>Delete Server</button>
        </fieldset>
      </form>
    </section>
  );
}

export function ManagedServerForm({
  onSubmit,
  dockerSocketMounted,
  nodes = [],
  preferredNodeId = "",
  versions,
  totalMemory = 0,
  provisioning = false,
  disabledReason = "",
  onRefreshNodes
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  dockerSocketMounted: boolean;
  nodes?: ContextNode[];
  preferredNodeId?: string;
  versions: FabricVersions;
  totalMemory?: number;
  provisioning?: boolean;
  disabledReason?: string;
  onRefreshNodes?: () => Promise<void> | void;
}) {
  const fallbackMinecraftVersions = useMemo(() => versions.game.map((version) => ({
    id: version.version,
    supported: version.stable,
    type: "release" as const,
    javaMajorVersion: version.version.startsWith("1.20.5") || version.version.startsWith("1.21") ? 21 as const : 17 as const
  })), [versions.game]);
  const [runtimeVersions, setRuntimeVersions] = useState<RuntimeMinecraftVersion[]>([]);
  const [runtimeVersionsLoading, setRuntimeVersionsLoading] = useState(false);
  const [runtimeVersionsError, setRuntimeVersionsError] = useState("");
  const [showSnapshots, setShowSnapshots] = useState(false);
  const availableMinecraftVersions = useMemo(() => runtimeVersions.length ? runtimeVersions : fallbackMinecraftVersions, [runtimeVersions, fallbackMinecraftVersions]);
  const visibleMinecraftVersions = useMemo(() => availableMinecraftVersions.filter((version) => version.supported && (showSnapshots || version.type !== "snapshot")), [availableMinecraftVersions, showSnapshots]);
  const defaultMinecraftVersion = visibleMinecraftVersions[0]?.id ?? availableMinecraftVersions[0]?.id ?? "1.21.4";
  const [minecraftVersion, setMinecraftVersion] = useState(defaultMinecraftVersion);
  const [loaderVersions, setLoaderVersions] = useState<RuntimeLoaderVersion[]>([]);
  const [loaderVersionsLoading, setLoaderVersionsLoading] = useState(false);
  const [loaderVersionsError, setLoaderVersionsError] = useState("");
  const [useRecommendedFabric, setUseRecommendedFabric] = useState(true);
  const [selectedLoaderVersion, setSelectedLoaderVersion] = useState("latest");
  const [runtimeProfile, setRuntimeProfile] = useState<ServerRuntimeProfile | null>(null);
  const [runtimeResolving, setRuntimeResolving] = useState(false);
  const [runtimeError, setRuntimeError] = useState("");
  const [runtimeWarnings, setRuntimeWarnings] = useState<string[]>([]);
  const [runtimeRetryKey, setRuntimeRetryKey] = useState(0);
  const [serverPort, setServerPort] = useState(String(defaultServerPort));
  const [queryPort, setQueryPort] = useState(String(defaultQueryPort));
  const [javaArgs, setJavaArgs] = useState(memoryArgs(4));
  const [refreshingNodes, setRefreshingNodes] = useState(false);
  const usableNodes = useMemo(() => nodes.filter(isNodeRuntimeUsable), [nodes]);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const serverPortValid = isValidServerPort(serverPort);
  const queryPortValid = isValidServerPort(queryPort);
  const portConflict = serverPort === queryPort;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedNodeTotalMemory = selectedNode?.totalMemory || totalMemory;
  const placementBlocked = nodes.length === 0 || usableNodes.length === 0 || !selectedNode || !isNodeRuntimeUsable(selectedNode);
  const placementBlockedReason = nodes.length === 0
    ? "Add a node before creating a server."
    : usableNodes.length === 0
      ? "No node is online, compatible, and Docker-ready."
      : !selectedNode
        ? "Choose a node before creating this server."
        : nodeBlockReason(selectedNode) || "Choose a ready node before creating this server.";

  async function loadRuntimeVersions() {
    setRuntimeVersionsLoading(true);
    setRuntimeVersionsError("");
    try {
      const result = await api<{ versions: RuntimeMinecraftVersion[] }>("/api/runtime/fabric/minecraft-versions");
      setRuntimeVersions(result.versions.filter((version) => version.supported));
    } catch (error) {
      setRuntimeVersionsError(error instanceof Error ? error.message : "Could not load Minecraft versions.");
    } finally {
      setRuntimeVersionsLoading(false);
    }
  }

  function retryRuntimeLookup() {
    setRuntimeVersionsError("");
    setLoaderVersionsError("");
    setRuntimeError("");
    setRuntimeWarnings([]);
    void loadRuntimeVersions();
    setRuntimeRetryKey((key) => key + 1);
  }

  useEffect(() => {
    void loadRuntimeVersions();
  }, []);

  useEffect(() => {
    if (!defaultMinecraftVersion) return;
    setMinecraftVersion((current) => (current && availableMinecraftVersions.some((version) => version.id === current)) ? current : defaultMinecraftVersion);
  }, [defaultMinecraftVersion, availableMinecraftVersions]);

  useEffect(() => {
    if (!minecraftVersion) return;
    let cancelled = false;
    setLoaderVersionsLoading(true);
    setLoaderVersionsError("");
    setLoaderVersions([]);
    if (useRecommendedFabric) setSelectedLoaderVersion("latest");
    api<{ loaderVersions: RuntimeLoaderVersion[] }>(`/api/runtime/fabric/loader-versions?minecraftVersion=${encodeURIComponent(minecraftVersion)}`)
      .then((result) => {
        if (cancelled) return;
        setLoaderVersions(result.loaderVersions);
        if (!useRecommendedFabric) {
          setSelectedLoaderVersion((current) => result.loaderVersions.some((version) => version.loaderVersion === current) ? current : result.loaderVersions[0]?.loaderVersion ?? "latest");
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setLoaderVersionsError(error instanceof Error ? error.message : "Could not load Fabric versions for this Minecraft version.");
      })
      .finally(() => {
        if (!cancelled) setLoaderVersionsLoading(false);
      });
    return () => { cancelled = true; };
  }, [minecraftVersion, useRecommendedFabric, runtimeRetryKey]);

  useEffect(() => {
    if (!minecraftVersion) {
      setRuntimeProfile(null);
      setRuntimeError("Choose a Minecraft version before creating this server.");
      return;
    }
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setRuntimeResolving(true);
      setRuntimeError("");
      setRuntimeWarnings([]);
      api<RuntimeResolveResponse>("/api/runtime/fabric/resolve", {
        method: "POST",
        body: JSON.stringify({
          minecraftVersion,
          loaderVersion: useRecommendedFabric ? "latest" : selectedLoaderVersion,
          preferStable: true
        })
      })
        .then((result) => {
          if (cancelled) return;
          setRuntimeProfile(result.runtimeProfile);
          setRuntimeWarnings(result.warnings ?? []);
          setRuntimeError("");
        })
        .catch((error) => {
          if (cancelled) return;
          setRuntimeProfile(null);
          setRuntimeError(error instanceof Error ? error.message : "Could not resolve a compatible Fabric runtime.");
        })
        .finally(() => {
          if (!cancelled) setRuntimeResolving(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [minecraftVersion, selectedLoaderVersion, useRecommendedFabric, runtimeRetryKey]);

  const runtimeReady = Boolean(runtimeProfile && !runtimeError && !runtimeResolving);
  const runtimeDockerImage = defaultDockerImageForMinecraftVersion(runtimeProfile?.minecraftVersion || minecraftVersion);
  const submittedLoaderVersion = useRecommendedFabric ? runtimeProfile?.loaderVersion || "latest" : selectedLoaderVersion;
  const runtimeIssueMessage = runtimeVersionsError || loaderVersionsError || runtimeError;
  const runtimeBusy = runtimeVersionsLoading || loaderVersionsLoading || runtimeResolving;

  useEffect(() => {
    if (preferredNodeId && usableNodes.some((node) => node.id === preferredNodeId)) {
      setSelectedNodeId(preferredNodeId);
      return;
    }
    if (usableNodes.length === 1) {
      setSelectedNodeId(usableNodes[0].id);
      return;
    }
    if (selectedNodeId && usableNodes.some((node) => node.id === selectedNodeId)) return;
    setSelectedNodeId(usableNodes[0]?.id ?? "");
  }, [preferredNodeId, selectedNodeId, usableNodes]);

  async function refreshNodeStatus() {
    if (!onRefreshNodes) return;
    setRefreshingNodes(true);
    try {
      await onRefreshNodes();
    } finally {
      setRefreshingNodes(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="appForm">
      <fieldset disabled={provisioning}>
      <section className="placementStep" aria-labelledby="placement-title">
        <div className="placementHeader">
          <span>Placement</span>
          <h3 id="placement-title">Where should this server run?</h3>
        </div>
        <div className="nodeSelectRow">
          <label className="nodeSelectField" htmlFor="create-node-select">
            Node
            <select
              id="create-node-select"
              name="nodeId"
              value={selectedNodeId}
              onChange={(event) => setSelectedNodeId(event.target.value)}
              disabled={provisioning || nodes.length === 0}
              required
            >
              <option value="">{nodes.length === 0 ? "No nodes available" : "Choose a node"}</option>
              {nodes.map((node) => {
                const usable = isNodeRuntimeUsable(node);
                const reason = nodeBlockReason(node);
                const label = node.isInternal ? "Internal Node" : node.name;
                return (
                  <option key={node.id} value={node.id} disabled={!usable}>
                    {usable ? label : `${label} (${reason || "Unavailable"})`}
                  </option>
                );
              })}
            </select>
          </label>
          <button
            type="button"
            className="iconButton nodeRefreshInlineButton"
            onClick={() => void refreshNodeStatus()}
            disabled={provisioning || refreshingNodes || !onRefreshNodes}
            aria-label="Refresh node status"
            title={refreshingNodes ? "Refreshing node status" : "Refresh node status"}
          >
            <AppIcon name="refresh" />
          </button>
        </div>
        {placementBlocked && nodes.length > 0 && (
          <p className="fieldError">{placementBlockedReason} If none are ready, open Nodes to see what needs attention.</p>
        )}
      </section>
      <label>
        Display name
        <input name="displayName" placeholder="Survival" required maxLength={80} />
      </label>
      <section className="runtimeSelection" aria-labelledby="create-runtime-title">
        <div className="placementHeader">
          <span>Runtime</span>
          <h3 id="create-runtime-title">Server runtime</h3>
        </div>
        <label>
          Minecraft version
          <select
            name="minecraftVersion"
            required
            value={minecraftVersion}
            onChange={(event) => {
              setMinecraftVersion(event.target.value);
              setUseRecommendedFabric(true);
              setSelectedLoaderVersion("latest");
            }}
            disabled={runtimeVersionsLoading}
          >
            {visibleMinecraftVersions.length ? visibleMinecraftVersions.map((version) => (
              <option key={version.id} value={version.id}>{version.id}{version.type === "snapshot" ? " snapshot" : ""}</option>
            )) : <option value="">No supported versions available</option>}
          </select>
          <span className="fieldHint">{runtimeVersionsLoading ? "Loading Fabric-compatible Minecraft versions..." : "Only supported Fabric server versions are shown."}</span>
        </label>
        {runtimeIssueMessage && (
          <InlineRuntimeError message={runtimeIssueMessage} actionLabel="Retry runtime lookup" onAction={retryRuntimeLookup} busy={runtimeBusy} />
        )}
        {availableMinecraftVersions.some((version) => version.type === "snapshot" && version.supported) && (
          <label className="checkLine">
            <input type="checkbox" checked={showSnapshots} onChange={(event) => setShowSnapshots(event.target.checked)} />
            Show snapshot versions
          </label>
        )}
        <div className="runtimeFixedRow">
          <span>Loader</span>
          <strong>Fabric</strong>
          <small>Fixed for now</small>
        </div>
        <label className="checkLine">
          <input
            type="checkbox"
            checked={useRecommendedFabric}
            onChange={(event) => {
              setUseRecommendedFabric(event.target.checked);
              if (event.target.checked) setSelectedLoaderVersion("latest");
            }}
          />
          Use recommended Fabric version
        </label>
        {!useRecommendedFabric && (
          <label>
            Fabric version
            <select
              name="loaderVersionExact"
              value={selectedLoaderVersion}
              onChange={(event) => setSelectedLoaderVersion(event.target.value)}
              disabled={loaderVersionsLoading || loaderVersions.length === 0}
            >
              {loaderVersions.map((version) => (
                <option key={version.id} value={version.loaderVersion}>{version.loaderVersion}{version.recommended ? " recommended" : ""}</option>
              ))}
            </select>
            <span className="fieldHint">{loaderVersionsLoading ? "Loading compatible Fabric versions..." : "Exact Fabric versions are advanced. Recommended is best for most servers."}</span>
          </label>
        )}
        <input type="hidden" name="loaderVersion" value={submittedLoaderVersion} />
        <input type="hidden" name="dockerImage" value={runtimeDockerImage} />
        <div className={`runtimePreview ${runtimeReady ? "resolved" : runtimeError ? "error" : "loading"}`}>
          <div>
            <span>Runtime summary</span>
            <strong>{runtimeProfile ? `${runtimeProfile.minecraftVersion} - Fabric ${runtimeProfile.loaderVersion}` : runtimeResolving ? "Resolving Fabric runtime" : "Runtime not resolved"}</strong>
          </div>
          <dl>
            <div><dt>Java</dt><dd>{runtimeProfile ? `Java ${runtimeProfile.javaMajorVersion}` : "Auto-selected"}</dd></div>
            <div><dt>Server jar</dt><dd>{runtimeProfile?.jarArtifact.filename || "Resolved by backend"}</dd></div>
            <div><dt>Source</dt><dd>{jarProviderLabel(runtimeProfile?.jarProvider)}</dd></div>
            <div><dt>Status</dt><dd>{runtimeStatusLabel(runtimeProfile?.compatibilityStatus)}</dd></div>
          </dl>
          {runtimeWarnings.map((warning) => <p key={warning} className="fieldHint warningText">{warning}</p>)}
        </div>
      </section>
      <MinecraftPortsSection
        serverPort={serverPort}
        queryPort={queryPort}
        onServerPortChange={setServerPort}
        onQueryPortChange={setQueryPort}
        serverPortValid={serverPortValid}
        queryPortValid={queryPortValid}
        portConflict={portConflict}
      />
      <label className="checkLine">
        <input name="acceptEula" type="checkbox" required />
        I accept the Minecraft EULA for this server.
      </label>
      <MemorySelector
        totalMemory={selectedNodeTotalMemory}
        initialMemoryGb={parseMaxMemoryGb(javaArgs)}
        javaArgs={javaArgs}
        onJavaArgsChange={setJavaArgs}
      />
      <details className="advanced">
        <summary>Advanced settings</summary>
        <label>
          Java arguments
          <textarea
            className="javaArgsInput"
            name="javaArgs"
            value={javaArgs}
            onChange={(event) => setJavaArgs(event.target.value)}
            rows={4}
            spellCheck={false}
          />
        </label>
        <p className="fieldHint">If -Xms and -Xmx differ, the memory slider adjusts -Xmx only and keeps your custom -Xms value.</p>
        <label>
          Docker container name
          <input name="dockerContainer" placeholder="serversentinel-survival" pattern="^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$" title="Use letters, numbers, dots, dashes, and underscores." />
        </label>
        <AdditionalPortBindingsEditor serverPort={serverPort} queryPort={queryPort} />
      </details>
      <p className="muted">
        {dockerSocketMounted ? "Docker is connected, so ServerSentinel can create and control this server." : "Docker is not connected yet. Connect Docker in Settings before using local runtime controls."}
      </p>
      <button
        disabled={provisioning || !serverPortValid || !queryPortValid || portConflict || placementBlocked || !runtimeReady}
        title={provisioning ? disabledReason || "Server setup is still running." : !serverPortValid ? `Use a port from ${minServerPort} to ${maxServerPort}.` : !queryPortValid ? `Use a Query port from ${minServerPort} to ${maxServerPort}.` : portConflict ? "Server port and Query port must be different." : placementBlocked ? placementBlockedReason : !runtimeReady ? runtimeIssueMessage || "Wait for the runtime profile to resolve." : "Create managed server"}
      >
        {provisioning ? "Setting up..." : "Create Managed Server"}
      </button>
      </fieldset>
    </form>
  );
}

function InlineRuntimeError({ message, actionLabel, onAction, busy = false }: { message: string; actionLabel?: string; onAction?: () => void; busy?: boolean }) {
  return (
    <div className="systemBanner warning compactBanner">
      <strong>Runtime unavailable.</strong>
      <span>{message}</span>
      {actionLabel && onAction && <button type="button" className="secondaryButton compactButton" onClick={onAction} disabled={busy}>{busy ? "Retrying..." : actionLabel}</button>}
    </div>
  );
}
