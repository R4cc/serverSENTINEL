import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ContextNode, FabricVersions, ManagedServer, RuntimeLoaderVersion } from '../types';
import { defaultDockerImageForMinecraftVersion, defaultQueryPort, defaultServerPort, fabricLoaderVersionInfo, formatBytes, isValidServerPort, javaMajorVersionForMinecraft, maxServerPort, memoryArgs, minecraftVersionInfo, minServerPort, parseJavaMemoryArgs, parseMaxMemoryGb, replaceMemoryArgs, totalMemoryGb, versionSourceLabel, versionValue } from '../utils/format';
import { isNodeRuntimeUsable, nodeBlockReason } from '../utils/nodes';
import { AppIcon } from '../components/FileTypeIcon';
import { Button } from '../components/UiPrimitives';
import { validateDisplayName, validateDockerContainerName, validateJavaArgs, validateRuntimeJarFilename } from '../utils/validation';

type PortBindingRow = {
  id: string;
  hostPort: string;
  target: string;
};

type CreateWizardPortBinding = {
  id: string;
  containerPort: string;
  protocol: "tcp" | "udp";
  hostPort: string;
  description: string;
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

const fallbackMinecraftVersions = [
  { version: "1.21.6", stable: true },
  { version: "1.21.4", stable: true },
  { version: "1.21.1", stable: true },
  { version: "1.20.6", stable: true },
  { version: "1.20.1", stable: true },
  { version: "1.19.4", stable: true },
  { version: "1.19.2", stable: true },
  { version: "1.18.2", stable: true },
  { version: "1.18", stable: true }
];

const fallbackFabricLoaderVersions: RuntimeLoaderVersion[] = [
  { id: "0.16.14", loaderVersion: "0.16.14", stable: true, recommended: true },
  { id: "0.16.13", loaderVersion: "0.16.13", stable: true },
  { id: "0.16.10", loaderVersion: "0.16.10", stable: true }
];

type CreateWizardMinecraftVersion = FabricVersions["game"][number];

function runtimeMinecraftOptions(versions: FabricVersions, showSnapshots: boolean): CreateWizardMinecraftVersion[] {
  const source: CreateWizardMinecraftVersion[] = versions.game.length > 0 ? versions.game : fallbackMinecraftVersions;
  const filtered = showSnapshots ? source : source.filter((version) => version.type === undefined || version.type === "release");
  return filtered.length > 0 ? filtered : source;
}

function preferredMinecraftVersion(options: CreateWizardMinecraftVersion[]) {
  return options.find((version) => version.version === "1.21.6")?.version
    || options.find((version) => version.type === undefined || version.type === "release")?.version
    || options[0]?.version
    || "1.21.6";
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function memoryBoundsForNode(totalMemory: number) {
  const max = totalMemoryGb(totalMemory);
  return {
    min: 1,
    max,
    recommendedMin: Math.min(2, max),
    recommendedMax: Math.min(Math.max(2, max), 8)
  };
}

function makeCreatePortBinding(partial: Partial<CreateWizardPortBinding> = {}): CreateWizardPortBinding {
  return {
    id: portBindingId(),
    containerPort: partial.containerPort ?? "",
    protocol: partial.protocol ?? "tcp",
    hostPort: partial.hostPort ?? "",
    description: partial.description ?? ""
  };
}

function wizardDockerPorts(serverPort: string, additionalBindings: CreateWizardPortBinding[]) {
  return [
    `${serverPort}:${serverPort}/tcp`,
    ...additionalBindings
      .filter((binding) => binding.hostPort.trim() && binding.containerPort.trim())
      .map((binding) => `${binding.hostPort.trim()}:${binding.containerPort.trim()}/${binding.protocol}`)
  ].join(",");
}

function serverUsedPortKeys(server: ManagedServer) {
  const keys = new Set<string>();
  for (const row of parsePortBindings(server.dockerPorts)) {
    const protocol = row.target.split("/", 2)[1] || "tcp";
    if (row.hostPort && (protocol === "tcp" || protocol === "udp")) {
      keys.add(`${row.hostPort}/${protocol}`);
    }
  }
  for (const port of server.managedPorts || []) {
    keys.add(`${port.externalPort}/${port.protocol}`);
  }
  return keys;
}

function usedPortKeysForNode(node: ContextNode | undefined) {
  const keys = new Set<string>();
  for (const server of node?.servers || []) {
    for (const key of serverUsedPortKeys(server)) {
      keys.add(key);
    }
  }
  return keys;
}

function findAvailablePort(usedKeys: Set<string>, protocol: "tcp" | "udp", preferred: number, avoidPorts: Set<string> = new Set()) {
  for (let port = preferred; port <= maxServerPort; port += 1) {
    const value = String(port);
    if (!avoidPorts.has(value) && !usedKeys.has(`${value}/${protocol}`)) return value;
  }
  for (let port = minServerPort; port < preferred; port += 1) {
    const value = String(port);
    if (!avoidPorts.has(value) && !usedKeys.has(`${value}/${protocol}`)) return value;
  }
  return String(preferred);
}

function wizardJavaArgs(minimumHeapGb: number, maximumHeapGb: number, currentArgs = "") {
  const withoutMemory = currentArgs
    .replace(/(^|\s)-Xms\S+/g, "")
    .replace(/(^|\s)-Xmx\S+/g, "")
    .trim();
  return [`-Xms${minimumHeapGb}G`, `-Xmx${maximumHeapGb}G`, withoutMemory].filter(Boolean).join(" ");
}

function nodeDisplayName(node: ContextNode | undefined) {
  if (!node) return "No node selected";
  return node.isInternal ? "Internal Node" : node.name;
}

function nodeStatusTextLabel(node: ContextNode | undefined) {
  if (!node) return "Not selected";
  return nodeStatusText(node);
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
        {bindings.map((binding) => (
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
            <Button
              variant="ghost"
              iconOnly
              className="iconDangerButton portBindingRemoveButton"
              onClick={() => removeBinding(binding.id)}
              aria-label="Remove port binding"
              title="Remove port binding"
            >
              <AppIcon name="trash" />
            </Button>
          </div>
        ))}
      </div>
      <Button variant="secondary" compact className="portBindingAddButton" onClick={addBinding}>
        <AppIcon name="plus" />
        <span>Add port binding</span>
      </Button>
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
        <select name="minecraftVersion" defaultValue={server.runtimeProfile.minecraftVersion}>
          {versions.game.length ? versions.game.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          )) : <option value={server.runtimeProfile.minecraftVersion}>{server.runtimeProfile.minecraftVersion}</option>}
        </select>
        <span className="fieldHint">Current: {versionValue(detectedMinecraftVersion)} ({versionSourceLabel(detectedMinecraftVersion.source)})</span>
      </label>
      <label>
        Fabric loader version
        <select name="loaderVersion" defaultValue={server.runtimeProfile.loaderVersion ?? ""}>
          <option value="">Latest stable</option>
          {versions.loader.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          ))}
        </select>
        <span className="fieldHint">Current: {versionValue(detectedFabricLoaderVersion)} ({versionSourceLabel(detectedFabricLoaderVersion.source)})</span>
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
        <input name="serverJar" defaultValue={server.runtimeProfile.jarArtifact.filename || "fabric-server-launch.jar"} pattern="^[^\\/]+\.jar$" title="Use a local .jar filename, not a path." />
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
      <Button type="submit" disabled={!serverPortValid || !queryPortValid || portConflict}>Save server settings</Button>
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
        <Button type="submit" variant="critical" disabled={!deleteConfirmed}>Delete Server</Button>
        </fieldset>
      </form>
    </section>
  );
}

export function ManagedServerForm({
  nodes = [],
  preferredNodeId = "",
  versions,
  totalMemory = 0,
  provisioning = false,
  disabledReason = "",
  onRefreshNodes,
  onSubmit
}: {
  nodes?: ContextNode[];
  preferredNodeId?: string;
  versions: FabricVersions;
  totalMemory?: number;
  provisioning?: boolean;
  disabledReason?: string;
  onRefreshNodes?: () => Promise<void> | void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [refreshingNodes, setRefreshingNodes] = useState(false);
  const usableNodes = useMemo(() => nodes.filter(isNodeRuntimeUsable), [nodes]);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [dockerContainer, setDockerContainer] = useState("");
  const [dockerImage, setDockerImage] = useState("");
  const [dockerImageCustomized, setDockerImageCustomized] = useState(false);
  const [serverJar, setServerJar] = useState("fabric-server-launch.jar");
  const [activeWizardStep, setActiveWizardStep] = useState<1 | 2 | 3 | 4>(1);
  const [minecraftVersion, setMinecraftVersion] = useState("");
  const [fabricLoaderVersion, setFabricLoaderVersion] = useState("");
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [compatibleLoaderVersions, setCompatibleLoaderVersions] = useState<RuntimeLoaderVersion[]>([]);
  const [minimumHeapGb, setMinimumHeapGb] = useState(2);
  const [maximumHeapGb, setMaximumHeapGb] = useState(8);
  const [javaArgs, setJavaArgs] = useState(() => wizardJavaArgs(2, 8));
  const [serverPort, setServerPort] = useState(String(defaultServerPort));
  const [queryPort, setQueryPort] = useState(String(defaultQueryPort));
  const [serverPortCustomized, setServerPortCustomized] = useState(false);
  const [queryPortCustomized, setQueryPortCustomized] = useState(false);
  const [additionalPortsOpen, setAdditionalPortsOpen] = useState(false);
  const [additionalPortBindings, setAdditionalPortBindings] = useState<CreateWizardPortBinding[]>([]);
  const [acceptEula, setAcceptEula] = useState(false);
  const [wizardError, setWizardError] = useState("");
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const nodeMemoryTotal = selectedNode?.totalMemory || totalMemory;
  const memoryBounds = useMemo(() => memoryBoundsForNode(nodeMemoryTotal), [nodeMemoryTotal]);
  const placementBlocked = nodes.length === 0 || usableNodes.length === 0 || !selectedNode || !isNodeRuntimeUsable(selectedNode);
  const placementBlockedReason = nodes.length === 0
    ? "Add a node before creating a server."
    : usableNodes.length === 0
      ? "No node is online, compatible, and Docker-ready."
      : !selectedNode
        ? "Choose a node before creating this server."
        : nodeBlockReason(selectedNode) || "Choose a ready node before creating this server.";
  const displayNameError = validateDisplayName(displayName);
  const dockerContainerError = dockerContainer.trim() ? validateDockerContainerName(dockerContainer) : null;
  const serverJarError = validateRuntimeJarFilename(serverJar);
  const javaArgsError = validateJavaArgs(javaArgs);
  const identityReady = !displayNameError;
  const nextDisabled = provisioning || placementBlocked || !identityReady;
  const minecraftOptions = useMemo(() => runtimeMinecraftOptions(versions, showSnapshots), [versions, showSnapshots]);
  const loaderOptions = useMemo(() => {
    const source = compatibleLoaderVersions.length > 0
      ? compatibleLoaderVersions
      : versions.loader.length > 0
        ? versions.loader.map((version, index) => ({
            id: version.version,
            loaderVersion: version.version,
            stable: version.stable,
            recommended: index === 0
          }))
        : fallbackFabricLoaderVersions;
    const filtered = showSnapshots ? source : source.filter((version) => version.stable !== false);
    return filtered.length > 0 ? filtered : source;
  }, [compatibleLoaderVersions, showSnapshots, versions.loader]);
  const recommendedLoader = loaderOptions.find((version) => version.recommended) || loaderOptions.find((version) => version.stable !== false) || loaderOptions[0];
  const summaryJavaVersion = javaMajorVersionForMinecraft(minecraftVersion);
  const runtimeCompatible = Boolean(minecraftVersion && fabricLoaderVersion);
  const usedPortKeys = useMemo(() => usedPortKeysForNode(selectedNode), [selectedNode]);
  const serverPortValid = isValidServerPort(serverPort);
  const queryPortValid = isValidServerPort(queryPort);
  const portConflict = serverPort === queryPort;
  const serverPortInUse = serverPortValid && usedPortKeys.has(`${serverPort}/tcp`);
  const queryPortInUse = queryPortValid && usedPortKeys.has(`${queryPort}/udp`);
  const additionalPortKeys = new Set<string>();
  const additionalPortsValid = additionalPortBindings.every((binding) => {
    if (!binding.containerPort.trim()) return false;
    if (!binding.hostPort.trim()) return false;
    if (!isValidServerPort(binding.containerPort)) return false;
    if (!isValidServerPort(binding.hostPort)) return false;
    if (binding.protocol !== "tcp" && binding.protocol !== "udp") return false;
    const key = `${binding.hostPort.trim()}/${binding.protocol}`;
    if (key === `${serverPort}/tcp` || key === `${queryPort}/udp` || usedPortKeys.has(key) || additionalPortKeys.has(key)) return false;
    additionalPortKeys.add(key);
    return true;
  });
  const portSettingsReady = serverPortValid && queryPortValid && !portConflict && !serverPortInUse && !queryPortInUse && additionalPortsValid;
  const resourcesReady = acceptEula && portSettingsReady && minimumHeapGb <= maximumHeapGb && !dockerContainerError && !serverJarError && !javaArgsError;
  const resourcesBlockedReason = !acceptEula
    ? "Accept the Minecraft EULA before continuing."
    : !serverPortValid
      ? `Use a server port from ${minServerPort} to ${maxServerPort}.`
      : serverPortInUse
        ? `Server port ${serverPort}/tcp is already used on this node.`
        : !queryPortValid
          ? `Use a Query port from ${minServerPort} to ${maxServerPort}.`
          : queryPortInUse
            ? `Query port ${queryPort}/udp is already used on this node.`
            : portConflict
              ? "Server port and Query port must be different."
              : !additionalPortsValid
                ? "Fix the additional port bindings before continuing."
                : dockerContainerError || serverJarError || javaArgsError || "";
  const dockerPorts = wizardDockerPorts(serverPort, additionalPortBindings);

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

  useEffect(() => {
    if (minecraftOptions.some((version) => version.version === minecraftVersion)) return;
    setMinecraftVersion(preferredMinecraftVersion(minecraftOptions));
  }, [minecraftOptions, minecraftVersion]);

  useEffect(() => {
    if (!selectedNode) return;
    const nextServerPort = serverPortCustomized
      ? serverPort
      : findAvailablePort(usedPortKeys, "tcp", defaultServerPort);
    const nextQueryPort = queryPortCustomized
      ? queryPort
      : findAvailablePort(usedPortKeys, "udp", defaultQueryPort, new Set([nextServerPort]));
    if (!serverPortCustomized && nextServerPort !== serverPort) setServerPort(nextServerPort);
    if (!queryPortCustomized && nextQueryPort !== queryPort) setQueryPort(nextQueryPort);
  }, [queryPort, queryPortCustomized, selectedNode, serverPort, serverPortCustomized, usedPortKeys]);

  useEffect(() => {
    if (!minecraftVersion) {
      setCompatibleLoaderVersions([]);
      return;
    }
    let cancelled = false;
    api<{ minecraftVersion: string; loaderVersions: RuntimeLoaderVersion[] }>(`/api/runtime/fabric/loader-versions?minecraftVersion=${encodeURIComponent(minecraftVersion)}`)
      .then((result) => {
        if (!cancelled) setCompatibleLoaderVersions(result.loaderVersions);
      })
      .catch(() => {
        if (!cancelled) setCompatibleLoaderVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [minecraftVersion]);

  useEffect(() => {
    if (loaderOptions.some((version) => version.loaderVersion === fabricLoaderVersion)) return;
    setFabricLoaderVersion(recommendedLoader?.loaderVersion || loaderOptions[0]?.loaderVersion || "");
  }, [fabricLoaderVersion, loaderOptions, recommendedLoader]);

  useEffect(() => {
    setMinimumHeapGb((current) => Math.min(clampNumber(current, memoryBounds.min, memoryBounds.max), maximumHeapGb));
    setMaximumHeapGb((current) => Math.max(clampNumber(current, memoryBounds.min, memoryBounds.max), minimumHeapGb));
  }, [maximumHeapGb, memoryBounds.max, memoryBounds.min, minimumHeapGb]);

  useEffect(() => {
    setJavaArgs((current) => wizardJavaArgs(minimumHeapGb, maximumHeapGb, current));
  }, [minimumHeapGb, maximumHeapGb]);

  useEffect(() => {
    if (!dockerImageCustomized) {
      setDockerImage(defaultDockerImageForMinecraftVersion(minecraftVersion));
    }
  }, [dockerImageCustomized, minecraftVersion]);

  useEffect(() => {
    if (wizardError && !placementBlocked && identityReady && runtimeCompatible && resourcesReady) {
      setWizardError("");
    }
  }, [identityReady, placementBlocked, resourcesReady, runtimeCompatible, wizardError]);

  function updateMinimumHeap(value: number) {
    const next = clampNumber(Math.round(value), memoryBounds.min, memoryBounds.max);
    setMinimumHeapGb(Math.min(next, maximumHeapGb));
  }

  function updateMaximumHeap(value: number) {
    const next = clampNumber(Math.round(value), memoryBounds.min, memoryBounds.max);
    setMaximumHeapGb(Math.max(next, minimumHeapGb));
  }

  function updateJavaArgs(value: string) {
    setJavaArgs(value);
    const memory = parseJavaMemoryArgs(value);
    if (memory.xmsGb !== null) {
      setMinimumHeapGb(clampNumber(memory.xmsGb, memoryBounds.min, Math.min(memoryBounds.max, maximumHeapGb)));
    }
    if (memory.xmxGb !== null) {
      setMaximumHeapGb(clampNumber(memory.xmxGb, Math.max(memoryBounds.min, minimumHeapGb), memoryBounds.max));
    }
  }

  function updateDockerImage(value: string) {
    setDockerImageCustomized(true);
    setDockerImage(value);
  }

  function updateDockerContainer(value: string) {
    setDockerContainer(value);
  }

  function updateServerPort(value: string) {
    setServerPortCustomized(true);
    setServerPort(value);
    if (!queryPortCustomized && value === queryPort) {
      setQueryPort(findAvailablePort(usedPortKeys, "udp", defaultQueryPort, new Set([value])));
    }
  }

  function updateQueryPort(value: string) {
    setQueryPortCustomized(true);
    setQueryPort(value);
  }

  function updateAdditionalPort(id: string, patch: Partial<CreateWizardPortBinding>) {
    setAdditionalPortBindings((current) => current.map((binding) => binding.id === id ? { ...binding, ...patch } : binding));
  }

  function addAdditionalPort() {
    setAdditionalPortsOpen(true);
    setAdditionalPortBindings((current) => [...current, makeCreatePortBinding()]);
  }

  function removeAdditionalPort(id: string) {
    setAdditionalPortBindings((current) => current.filter((binding) => binding.id !== id));
  }

  function validateWizardBeforeCreate() {
    if (placementBlocked || !identityReady) {
      setActiveWizardStep(1);
      setWizardError(placementBlocked ? placementBlockedReason : "Complete placement and identity before creating this server.");
      return false;
    }
    if (!runtimeCompatible) {
      setActiveWizardStep(2);
      setWizardError("Choose a valid Minecraft runtime before creating this server.");
      return false;
    }
    if (!resourcesReady) {
      setActiveWizardStep(3);
      setWizardError(!acceptEula
        ? "Accept the Minecraft EULA before creating this server."
        : resourcesBlockedReason || "Review memory, port, and advanced setting values before creating this server.");
      return false;
    }
    setWizardError("");
    return true;
  }

  function submitWizard(event: FormEvent<HTMLFormElement>) {
    if (!validateWizardBeforeCreate()) {
      event.preventDefault();
      return;
    }
    onSubmit(event);
  }

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
    <form className="createWizardPage" onSubmit={submitWizard}>
      <CreateServerStepper activeStep={activeWizardStep} />

      <section className="createWizardCard">
        {wizardError && <div className="createWizardValidation" role="alert">{wizardError}</div>}
        {activeWizardStep === 1 ? (
          <>
            <div className="modInstallStepIntro">
              <h3>Placement & Identity</h3>
              <p>Choose where to host your server and give it a name.</p>
            </div>

            <div className="createWizardFields">
              <div className="createWizardField">
                <label htmlFor="create-node-select">Node</label>
                <span className="fieldHint">Select the node where this server will be created.</span>
                <div className="nodeSelectRow">
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
                  <Button
                    variant="secondary"
                    iconOnly
                    className="iconButton nodeRefreshInlineButton"
                    onClick={() => void refreshNodeStatus()}
                    disabled={provisioning || refreshingNodes || !onRefreshNodes}
                    aria-label="Refresh node list"
                    title={refreshingNodes ? "Refreshing node list" : "Refresh node list"}
                  >
                    <AppIcon name="refresh" />
                  </Button>
                </div>
                {placementBlocked && nodes.length > 0 && (
                  <p className="fieldError">{placementBlockedReason} If none are ready, open Nodes to see what needs attention.</p>
                )}
              </div>

              <div className="createWizardField">
                <label htmlFor="create-display-name">Display name</label>
                <span className="fieldHint">This is how your server will be displayed in the panel.</span>
                <input
                  id="create-display-name"
                  name="displayName"
                  placeholder="Survival"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  required
                  maxLength={80}
                  aria-invalid={Boolean(displayNameError)}
                />
                {displayNameError && <span className="fieldError">{displayNameError}</span>}
              </div>

              <NodeOverviewCard node={selectedNode} fallbackMemory={totalMemory} />
            </div>
          </>
        ) : activeWizardStep === 2 ? (
          <RuntimeWizardStep
            minecraftVersion={minecraftVersion}
            minecraftOptions={minecraftOptions}
            fabricLoaderVersion={fabricLoaderVersion}
            loaderOptions={loaderOptions}
            recommendedLoaderVersion={recommendedLoader?.loaderVersion || ""}
            showSnapshots={showSnapshots}
            javaVersion={summaryJavaVersion}
            runtimeCompatible={runtimeCompatible}
            onMinecraftVersionChange={setMinecraftVersion}
            onFabricLoaderVersionChange={setFabricLoaderVersion}
            onShowSnapshotsChange={setShowSnapshots}
          />
        ) : activeWizardStep === 3 ? (
          <ResourcesNetworkWizardStep
            memoryBounds={memoryBounds}
            minimumHeapGb={minimumHeapGb}
            maximumHeapGb={maximumHeapGb}
            javaArgs={javaArgs}
            serverJar={serverJar}
            dockerImage={dockerImage}
            dockerContainer={dockerContainer}
            serverPort={serverPort}
            queryPort={queryPort}
            serverPortValid={serverPortValid}
            queryPortValid={queryPortValid}
            portConflict={portConflict}
            serverPortInUse={serverPortInUse}
            queryPortInUse={queryPortInUse}
            additionalPortsOpen={additionalPortsOpen}
            additionalPortBindings={additionalPortBindings}
            additionalPortsValid={additionalPortsValid}
            javaArgsError={javaArgsError}
            serverJarError={serverJarError}
            dockerContainerError={dockerContainerError}
            acceptEula={acceptEula}
            onMinimumHeapChange={updateMinimumHeap}
            onMaximumHeapChange={updateMaximumHeap}
            onJavaArgsChange={updateJavaArgs}
            onServerJarChange={setServerJar}
            onDockerImageChange={updateDockerImage}
            onDockerContainerChange={updateDockerContainer}
            onServerPortChange={updateServerPort}
            onQueryPortChange={updateQueryPort}
            onAdditionalPortsOpenChange={setAdditionalPortsOpen}
            onAddAdditionalPort={addAdditionalPort}
            onUpdateAdditionalPort={updateAdditionalPort}
            onRemoveAdditionalPort={removeAdditionalPort}
            onAcceptEulaChange={setAcceptEula}
          />
        ) : (
          <ReviewCreateWizardStep
            node={selectedNode}
            displayName={displayName}
            dockerContainer={dockerContainer}
            dockerImage={dockerImage}
            serverJar={serverJar}
            javaArgs={javaArgs}
            minecraftVersion={minecraftVersion}
            fabricLoaderVersion={fabricLoaderVersion}
            javaVersion={summaryJavaVersion}
            minimumHeapGb={minimumHeapGb}
            maximumHeapGb={maximumHeapGb}
            serverPort={serverPort}
            queryPort={queryPort}
            additionalPortBindings={additionalPortBindings}
            acceptEula={acceptEula}
            onEditStep={setActiveWizardStep}
          />
        )}
        <div className="modInstallFooter createWizardFooter">
          {activeWizardStep === 1 ? (
            <>
              <span className="modInstallFooterSpacer" />
              <Button
                onClick={() => {
                  setWizardError("");
                  setActiveWizardStep(2);
                }}
                disabled={nextDisabled}
                title={nextDisabled ? disabledReason || placementBlockedReason || "Complete placement and identity before continuing." : "Continue to runtime"}
              >
                <span>Next: Runtime</span>
                <AppIcon name="chevronRight" />
              </Button>
            </>
          ) : activeWizardStep === 2 ? (
            <>
              <Button variant="secondary" onClick={() => {
                setWizardError("");
                setActiveWizardStep(1);
              }}>
                <AppIcon name="chevronLeft" />
                <span>Back: Placement & Identity</span>
              </Button>
              <span className="modInstallFooterSpacer" />
              <Button onClick={() => {
                setWizardError("");
                setActiveWizardStep(3);
              }} disabled={!runtimeCompatible}>
                <span>Next: Resources & Network</span>
                <AppIcon name="chevronRight" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => {
                setWizardError("");
                setActiveWizardStep(activeWizardStep === 3 ? 2 : 3);
              }}>
                <AppIcon name="chevronLeft" />
                <span>{activeWizardStep === 3 ? "Back: Runtime" : "Back: Resources & Network"}</span>
              </Button>
              <span className="modInstallFooterSpacer" />
              <Button type={activeWizardStep === 3 ? "button" : "submit"} onClick={activeWizardStep === 3 ? () => {
                setWizardError("");
                setActiveWizardStep(4);
              } : undefined} disabled={activeWizardStep === 3 ? !resourcesReady : provisioning} title={activeWizardStep === 3 && !resourcesReady ? resourcesBlockedReason || "Complete resources and network settings before continuing." : undefined}>
                {activeWizardStep === 4 && <AppIcon name="server" />}
                <span>{activeWizardStep === 3 ? "Next: Review & Create" : provisioning ? "Creating..." : "Create Server"}</span>
                {activeWizardStep === 3 && <AppIcon name="chevronRight" />}
              </Button>
            </>
          )}
        </div>
      </section>
      <input type="hidden" name="nodeId" value={selectedNodeId} />
      <input type="hidden" name="displayName" value={displayName} />
      <input type="hidden" name="dockerContainer" value={dockerContainer} />
      <input type="hidden" name="dockerImage" value={dockerImage} />
      <input type="hidden" name="minecraftVersion" value={minecraftVersion} />
      <input type="hidden" name="loaderVersion" value={fabricLoaderVersion} />
      <input type="hidden" name="serverJar" value={serverJar} />
      <input type="hidden" name="javaArgs" value={javaArgs} />
      <input type="hidden" name="serverPort" value={serverPort} />
      <input type="hidden" name="queryPort" value={queryPort} />
      <input type="hidden" name="dockerPorts" value={dockerPorts} />
      {acceptEula && <input type="hidden" name="acceptEula" value="on" />}
    </form>
  );
}

function RuntimeWizardStep({
  minecraftVersion,
  minecraftOptions,
  fabricLoaderVersion,
  loaderOptions,
  recommendedLoaderVersion,
  showSnapshots,
  javaVersion,
  runtimeCompatible,
  onMinecraftVersionChange,
  onFabricLoaderVersionChange,
  onShowSnapshotsChange
}: {
  minecraftVersion: string;
  minecraftOptions: CreateWizardMinecraftVersion[];
  fabricLoaderVersion: string;
  loaderOptions: RuntimeLoaderVersion[];
  recommendedLoaderVersion: string;
  showSnapshots: boolean;
  javaVersion: 17 | 21 | 25;
  runtimeCompatible: boolean;
  onMinecraftVersionChange: (value: string) => void;
  onFabricLoaderVersionChange: (value: string) => void;
  onShowSnapshotsChange: (value: boolean) => void;
}) {
  return (
    <>
      <div className="modInstallStepIntro">
        <h3>Runtime</h3>
        <p>Select the Minecraft version and loader you want to run.</p>
      </div>

      <div className="createWizardFields runtimeWizardFields">
        <div className="createWizardField">
          <label htmlFor="create-minecraft-version">Minecraft version</label>
          <span className="fieldHint">Choose the Minecraft version for your server.</span>
          <select
            id="create-minecraft-version"
            name="minecraftVersion"
            value={minecraftVersion}
            onChange={(event) => onMinecraftVersionChange(event.target.value)}
            required
          >
            {minecraftOptions.map((version) => (
              <option key={version.version} value={version.version}>
                {version.version}{version.type === "snapshot" ? " (Snapshot)" : ""}
              </option>
            ))}
          </select>
        </div>

        <section className="runtimeLoaderSection" aria-labelledby="runtime-loader-title">
          <div>
            <strong id="runtime-loader-title">Loader</strong>
            <span className="fieldHint">Select the loader type for your server.</span>
          </div>
          <button type="button" className="runtimeLoaderCard selected" aria-pressed="true">
            <span className="fabricLoaderMark" aria-hidden="true">
              <svg viewBox="0 0 13 14" shapeRendering="crispEdges">
                <path className="fabricLogoOutline" d="M7 0h1v1h1v1h1v1h1v1h1v1h1v3h-1v1h-1v1h-1v1H9v1H8v1H6v1H4v-1H3v-1H2v-1H1v-1H0V8h1V7h1V6h1V5h1V4h1V3h1V1h1Z" />
                <path className="fabricLogoMain" d="M7 1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1H9v1H8v1H7v1H5v1H4v-1H3v-1H2v-1H1V8h1V7h1V6h1V5h1V4h1V2h1Z" />
                <path className="fabricLogoHighlight" d="M7 1h1v1h1v1h1v1h1v1h-1v1H9V5H8V4H7V3H6V2h1Z" />
                <path className="fabricLogoShade" d="M11 5h1v2h-1v1h-1v1H9v1H8v1H7v1H5v1H4v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1Z" />
                <path className="fabricLogoThread" d="M10 3h1v1h1v1h-1V4h-1ZM11 7h1v1h-1ZM9 9h1v1H9Z" />
              </svg>
            </span>
            <span className="runtimeLoaderCopy">
              <span>
                <strong>Fabric</strong>
                <mark className="settingsStatus ready">Recommended</mark>
              </span>
              <small>Lightweight and modular modding framework.</small>
            </span>
            <span className="runtimeLoaderCheck" aria-hidden="true"><AppIcon name="check" /></span>
          </button>
        </section>

        <div className="createWizardField">
          <label htmlFor="create-fabric-loader-version">Fabric loader version</label>
          <span className="fieldHint">Choose the Fabric loader version that is compatible with your selected Minecraft version.</span>
          <select
            id="create-fabric-loader-version"
            name="loaderVersion"
            value={fabricLoaderVersion}
            onChange={(event) => onFabricLoaderVersionChange(event.target.value)}
            required
          >
            {loaderOptions.map((version) => (
              <option key={version.id || version.loaderVersion} value={version.loaderVersion}>
                {version.loaderVersion}{version.loaderVersion === recommendedLoaderVersion ? " (Recommended)" : ""}
              </option>
            ))}
          </select>
        </div>

        <label className="runtimeSnapshotToggle">
          <span className="switch">
            <input
              type="checkbox"
              checked={showSnapshots}
              onChange={(event) => onShowSnapshotsChange(event.target.checked)}
            />
            <span className="slider" />
          </span>
          <span>
            <strong>Show snapshot versions</strong>
            <small>Include snapshot and development builds.</small>
          </span>
        </label>

        <RuntimeSummary
          minecraftVersion={minecraftVersion}
          fabricLoaderVersion={fabricLoaderVersion}
          javaVersion={javaVersion}
          runtimeCompatible={runtimeCompatible}
        />
      </div>
    </>
  );
}

function RuntimeSummary({
  minecraftVersion,
  fabricLoaderVersion,
  javaVersion,
  runtimeCompatible
}: {
  minecraftVersion: string;
  fabricLoaderVersion: string;
  javaVersion: 17 | 21 | 25;
  runtimeCompatible: boolean;
}) {
  return (
    <section className="runtimeSummaryCard" aria-labelledby="runtime-summary-title">
      <div className="runtimeSummaryHeader">
        <strong id="runtime-summary-title">Runtime summary</strong>
        <span>Review your selected runtime details.</span>
      </div>
      <div className="runtimeSummaryGrid">
        <RuntimeSummaryItem label="Minecraft version" value={minecraftVersion || "Choose version"} icon="grass" />
        <RuntimeSummaryItem label="Loader" value="Fabric" icon="loader" />
        <RuntimeSummaryItem label="Fabric version" value={fabricLoaderVersion || "Choose version"} />
        <RuntimeSummaryItem label="Java version" value={`Java ${javaVersion}`} icon="java" />
        <RuntimeSummaryItem label="Server JAR source" value="fabric-server-launch.jar" />
        <RuntimeSummaryItem label="Compatibility" value={runtimeCompatible ? "Compatible" : "Incomplete"} tone={runtimeCompatible ? "ok" : "warning"} />
      </div>
    </section>
  );
}

function RuntimeSummaryItem({
  label,
  value,
  icon,
  tone
}: {
  label: string;
  value: string;
  icon?: "grass" | "loader" | "java";
  tone?: "ok" | "warning";
}) {
  return (
    <div className="runtimeSummaryItem">
      <span>{label}</span>
      <strong className={tone ? `runtimeSummaryStatus ${tone}` : ""}>
        {icon && <RuntimeSummaryIcon icon={icon} />}
        {tone && <span className="runtimeSummaryDot" aria-hidden="true" />}
        {value}
      </strong>
    </div>
  );
}

function RuntimeSummaryIcon({ icon }: { icon: "grass" | "loader" | "java" }) {
  if (icon === "java") return <span className="runtimeSummaryEmoji" aria-hidden="true">J</span>;
  if (icon === "loader") {
    return (
      <svg className="runtimeSummaryIcon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 4h8l4 7-8 9-8-9Z" />
        <path d="M8 4l4 16 4-16" />
      </svg>
    );
  }
  return (
    <svg className="runtimeSummaryIcon grass" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9 12 5l8 4-8 4Z" />
      <path d="M4 9v6l8 4 8-4V9" />
      <path d="M12 13v6" />
    </svg>
  );
}

function ResourcesNetworkWizardStep({
  memoryBounds,
  minimumHeapGb,
  maximumHeapGb,
  javaArgs,
  serverJar,
  dockerImage,
  dockerContainer,
  serverPort,
  queryPort,
  serverPortValid,
  queryPortValid,
  portConflict,
  serverPortInUse,
  queryPortInUse,
  additionalPortsOpen,
  additionalPortBindings,
  additionalPortsValid,
  javaArgsError,
  serverJarError,
  dockerContainerError,
  acceptEula,
  onMinimumHeapChange,
  onMaximumHeapChange,
  onJavaArgsChange,
  onServerJarChange,
  onDockerImageChange,
  onDockerContainerChange,
  onServerPortChange,
  onQueryPortChange,
  onAdditionalPortsOpenChange,
  onAddAdditionalPort,
  onUpdateAdditionalPort,
  onRemoveAdditionalPort,
  onAcceptEulaChange
}: {
  memoryBounds: { min: number; max: number; recommendedMin: number; recommendedMax: number };
  minimumHeapGb: number;
  maximumHeapGb: number;
  javaArgs: string;
  serverJar: string;
  dockerImage: string;
  dockerContainer: string;
  serverPort: string;
  queryPort: string;
  serverPortValid: boolean;
  queryPortValid: boolean;
  portConflict: boolean;
  serverPortInUse: boolean;
  queryPortInUse: boolean;
  additionalPortsOpen: boolean;
  additionalPortBindings: CreateWizardPortBinding[];
  additionalPortsValid: boolean;
  javaArgsError: string | null;
  serverJarError: string | null;
  dockerContainerError: string | null;
  acceptEula: boolean;
  onMinimumHeapChange: (value: number) => void;
  onMaximumHeapChange: (value: number) => void;
  onJavaArgsChange: (value: string) => void;
  onServerJarChange: (value: string) => void;
  onDockerImageChange: (value: string) => void;
  onDockerContainerChange: (value: string) => void;
  onServerPortChange: (value: string) => void;
  onQueryPortChange: (value: string) => void;
  onAdditionalPortsOpenChange: (value: boolean) => void;
  onAddAdditionalPort: () => void;
  onUpdateAdditionalPort: (id: string, patch: Partial<CreateWizardPortBinding>) => void;
  onRemoveAdditionalPort: (id: string) => void;
  onAcceptEulaChange: (value: boolean) => void;
}) {
  return (
    <>
      <div className="modInstallStepIntro">
        <h3>Resources & Network</h3>
        <p>Configure the resources your server will use and how it can be accessed.</p>
      </div>

      <div className="createWizardFields resourcesWizardFields">
        <section className="resourceStepSection" aria-labelledby="create-memory-title">
          <div className="resourceSectionIntro">
            <h4 id="create-memory-title">Memory</h4>
            <p>Configure the memory allocation for your server.</p>
          </div>
          <div className="memoryRangeLayout">
            <MemoryRangeControl
              bounds={memoryBounds}
              minimumHeapGb={minimumHeapGb}
              maximumHeapGb={maximumHeapGb}
              onMinimumHeapChange={onMinimumHeapChange}
              onMaximumHeapChange={onMaximumHeapChange}
            />
            <div className="memoryNumberFields">
              <MemoryNumberInput
                id="create-minimum-heap"
                label="Minimum heap (Xms)"
                value={minimumHeapGb}
                min={memoryBounds.min}
                max={maximumHeapGb}
                onChange={onMinimumHeapChange}
              />
              <span className="memoryHeapDivider" aria-hidden="true">/</span>
              <MemoryNumberInput
                id="create-maximum-heap"
                label="Maximum heap (Xmx)"
                value={maximumHeapGb}
                min={minimumHeapGb}
                max={memoryBounds.max}
                onChange={onMaximumHeapChange}
              />
            </div>
          </div>
          <div className="memoryRangeMeta">
            <span>Recommended: {memoryBounds.recommendedMin} GB - {memoryBounds.recommendedMax} GB</span>
            <span>Total available: {memoryBounds.max} GB</span>
          </div>
          <input type="hidden" name="javaArgs" value={javaArgs} />
        </section>

        <section className="resourceStepSection networkPortsSection" aria-labelledby="create-network-title">
          <div className="resourceSectionIntro">
            <h4 id="create-network-title">Network ports</h4>
            <p>Configure the primary ports used by your server.</p>
          </div>
          <div className="networkPortGrid">
            <ProtocolInput
              id="create-server-port"
            name="serverPort"
            label="Server port"
            helper="The port players use to join your server."
            protocol="TCP"
            value={serverPort}
              invalid={!serverPortValid || portConflict || serverPortInUse}
              error={!serverPortValid
                ? `Use ${minServerPort}-${maxServerPort}.`
                : serverPortInUse
                  ? `${serverPort}/tcp is already used on this node.`
                  : portConflict
                    ? "Must differ from Query port."
                    : ""}
              onChange={onServerPortChange}
            />
            <ProtocolInput
              id="create-query-port"
              name="queryPort"
              label="Query port"
            helper="Used by ServerSentinel for player metrics."
            protocol="UDP"
            value={queryPort}
              invalid={!queryPortValid || portConflict || queryPortInUse}
              error={!queryPortValid
                ? `Use ${minServerPort}-${maxServerPort}.`
                : queryPortInUse
                  ? `${queryPort}/udp is already used on this node.`
                  : portConflict
                    ? "Must differ from server port."
                    : ""}
              onChange={onQueryPortChange}
            />
          </div>
          {!serverPortValid && <span className="fieldError">Use a server port from {minServerPort} to {maxServerPort}.</span>}
          {!queryPortValid && <span className="fieldError">Use a Query port from {minServerPort} to {maxServerPort}.</span>}
          {serverPortInUse && <span className="fieldError">Server port {serverPort}/tcp is already used on this node.</span>}
          {queryPortInUse && <span className="fieldError">Query port {queryPort}/udp is already used on this node.</span>}
          {portConflict && <span className="fieldError">Server port and Query port must be different.</span>}

          <AdditionalPortBindingsPanel
            open={additionalPortsOpen}
            bindings={additionalPortBindings}
            valid={additionalPortsValid}
            onOpenChange={onAdditionalPortsOpenChange}
            onAdd={onAddAdditionalPort}
            onUpdate={onUpdateAdditionalPort}
            onRemove={onRemoveAdditionalPort}
          />
        </section>

        <section className="resourceStepSection eulaSection" aria-labelledby="create-eula-title">
          <div className="resourceSectionIntro">
            <h4 id="create-eula-title">EULA</h4>
            <p>You must accept the Minecraft End User License Agreement to create a server.</p>
          </div>
          <div className="eulaActionRow">
            <label className="resourceCheckboxLine">
              <input
                type="checkbox"
                name="acceptEula"
                checked={acceptEula}
                onChange={(event) => onAcceptEulaChange(event.target.checked)}
              />
              <span>I accept the Minecraft EULA for this server.</span>
            </label>
            <a href="https://www.minecraft.net/eula" target="_blank" rel="noopener noreferrer" className="resourceInlineLink">
              View Minecraft EULA
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <path d="M15 3h6v6" />
                <path d="M10 14 21 3" />
              </svg>
            </a>
          </div>
        </section>

        <details className="resourceDisclosure advancedResourceDisclosure">
          <summary>
            <span className="advancedResourceIcon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
                <path d="m19 13.5.1-1.5-.1-1.5 1.8-1.4-1.8-3.1-2.2.9a7.5 7.5 0 0 0-2.2-1.3L14.2 3h-4.4l-.4 2.6A7.5 7.5 0 0 0 7.2 6.9L5 6 3.2 9.1 5 10.5 4.9 12l.1 1.5-1.8 1.4L5 18l2.2-.9c.7.6 1.4 1 2.2 1.3l.4 2.6h4.4l.4-2.6c.8-.3 1.5-.7 2.2-1.3L19 18l1.8-3.1Z" />
              </svg>
            </span>
            <span>
              <strong>Advanced settings <em>(optional)</em></strong>
              <small>Java arguments, Docker container name, and other advanced options.</small>
            </span>
          </summary>
          <div className="advancedResourceBody">
            <div className="advancedResourceGrid">
              <label className="advancedResourceField" htmlFor="create-java-args">
                <span>Java arguments</span>
                <small>Customize the launch flags used by the Minecraft runtime.</small>
                <textarea
                  id="create-java-args"
                  className="javaArgsInput"
                  value={javaArgs}
                  onChange={(event) => onJavaArgsChange(event.target.value)}
                  rows={3}
                  spellCheck={false}
                  aria-invalid={Boolean(javaArgsError)}
                />
                {javaArgsError && <span className="fieldError">{javaArgsError}</span>}
              </label>

              <label className="advancedResourceField" htmlFor="create-docker-image">
                <span>Docker runtime image</span>
                <small>Choose the Java runtime image used for the server container.</small>
                <select
                  id="create-docker-image"
                  value={dockerImage}
                  onChange={(event) => onDockerImageChange(event.target.value)}
                >
                  <option value="eclipse-temurin:21-jre">Java 21 runtime</option>
                  <option value="eclipse-temurin:17-jre">Java 17 runtime</option>
                  <option value="eclipse-temurin:25-jre">Java 25 runtime</option>
                </select>
              </label>

              <label className="advancedResourceField" htmlFor="create-server-jar">
                <span>Server jar filename</span>
                <small>The downloaded Fabric launcher will be saved with this local filename.</small>
                <input
                  id="create-server-jar"
                  type="text"
                  value={serverJar}
                  onChange={(event) => onServerJarChange(event.target.value)}
                  placeholder="fabric-server-launch.jar"
                  aria-invalid={Boolean(serverJarError)}
                />
                {serverJarError && <span className="fieldError">{serverJarError}</span>}
              </label>

              <label className="advancedResourceField" htmlFor="create-docker-container">
                <span>Docker container name</span>
                <small>Leave blank to generate a stable name from the server ID.</small>
                <input
                  id="create-docker-container"
                  type="text"
                  placeholder="Auto-generated"
                  value={dockerContainer}
                  onChange={(event) => onDockerContainerChange(event.target.value)}
                  pattern="^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$"
                  maxLength={128}
                  aria-invalid={Boolean(dockerContainerError)}
                />
                {dockerContainerError && <span className="fieldError">{dockerContainerError}</span>}
              </label>
            </div>
          </div>
        </details>
      </div>
    </>
  );
}

function MemoryRangeControl({
  bounds,
  minimumHeapGb,
  maximumHeapGb,
  onMinimumHeapChange,
  onMaximumHeapChange
}: {
  bounds: { min: number; max: number; recommendedMin: number; recommendedMax: number };
  minimumHeapGb: number;
  maximumHeapGb: number;
  onMinimumHeapChange: (value: number) => void;
  onMaximumHeapChange: (value: number) => void;
}) {
  const span = Math.max(1, bounds.max - bounds.min);
  const minPercent = ((minimumHeapGb - bounds.min) / span) * 100;
  const maxPercent = ((maximumHeapGb - bounds.min) / span) * 100;
  const quarter = Math.round(bounds.min + span * 0.25);
  const midpoint = Math.round(bounds.min + span * 0.5);
  const threeQuarter = Math.round(bounds.min + span * 0.75);
  const sliderStyle = {
    "--xms-percent": `${minPercent}%`,
    "--xmx-percent": `${maxPercent}%`
  } as CSSProperties;

  return (
    <div className="memoryRangeControl" style={sliderStyle}>
      <div className="memoryRangeTrackWrap">
        <span className="memoryValueBubble xms">{minimumHeapGb} GB</span>
        <span className="memoryValueBubble xmx">{maximumHeapGb} GB</span>
        <div className="memoryRangeTrack" aria-hidden="true" />
        <input
          aria-label="Minimum heap Xms"
          type="range"
          min={bounds.min}
          max={bounds.max}
          step="1"
          value={minimumHeapGb}
          onChange={(event) => onMinimumHeapChange(Number(event.target.value))}
          className="memoryRangeInput xms"
        />
        <input
          aria-label="Maximum heap Xmx"
          type="range"
          min={bounds.min}
          max={bounds.max}
          step="1"
          value={maximumHeapGb}
          onChange={(event) => onMaximumHeapChange(Number(event.target.value))}
          className="memoryRangeInput xmx"
        />
      </div>
      <div className="memoryTicks" aria-hidden="true">
        <span>{bounds.min} GB</span>
        <span>{quarter} GB</span>
        <span>{midpoint} GB</span>
        <span>{threeQuarter} GB</span>
        <span>{bounds.max} GB</span>
      </div>
    </div>
  );
}

function MemoryNumberInput({
  id,
  label,
  value,
  min,
  max,
  onChange
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="memoryNumberField" htmlFor={id}>
      <span className="memoryNumberInputWrap">
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <strong>GB</strong>
      </span>
      <small>{label}</small>
    </label>
  );
}

function ProtocolInput({
  id,
  name,
  label,
  helper,
  protocol,
  value,
  invalid,
  error,
  onChange
}: {
  id: string;
  name: string;
  label: string;
  helper: string;
  protocol: "TCP" | "UDP";
  value: string;
  invalid: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="protocolInputField" htmlFor={id}>
      <span>{label}</span>
      <small>{helper}</small>
      <span className="protocolInputWrap">
        <input
          id={id}
          name={name}
          type="number"
          inputMode="numeric"
          min={minServerPort}
          max={maxServerPort}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={invalid}
        />
        <strong>{protocol}</strong>
      </span>
      {error && <span className="fieldErrorBubble" role="tooltip">{error}</span>}
    </label>
  );
}

function AdditionalPortBindingsPanel({
  open,
  bindings,
  valid,
  onOpenChange,
  onAdd,
  onUpdate,
  onRemove
}: {
  open: boolean;
  bindings: CreateWizardPortBinding[];
  valid: boolean;
  onOpenChange: (value: boolean) => void;
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<CreateWizardPortBinding>) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <section className={`resourceDisclosure additionalPortsDisclosure ${open ? "open" : ""}`} aria-labelledby="additional-ports-title">
      <button type="button" className="resourceDisclosureSummary" onClick={() => onOpenChange(!open)} aria-expanded={open}>
        <span>
          <strong id="additional-ports-title">Additional port bindings <em>(optional)</em></strong>
          <small>Expose additional ports to the server, for example for mods or plugins.</small>
        </span>
        <AppIcon name={open ? "chevronUp" : "chevronDown"} />
      </button>
      {open && (
        <div className="additionalPortsBody">
          <div className="additionalPortsGrid" role="group" aria-label="Additional port bindings">
            <div className="additionalPortsHeader" aria-hidden="true">
              <span>Container port</span>
              <span>Protocol</span>
              <span>Host port</span>
              <span>Description (optional)</span>
              <span />
            </div>
            {bindings.map((binding) => (
              <div className="additionalPortRow" key={binding.id}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={minServerPort}
                  max={maxServerPort}
                  value={binding.containerPort}
                  onChange={(event) => onUpdate(binding.id, { containerPort: event.target.value })}
                  aria-label="Container port"
                  aria-invalid={Boolean(binding.containerPort) && !isValidServerPort(binding.containerPort)}
                  placeholder="8123"
                  required
                />
                <select
                  value={binding.protocol}
                  onChange={(event) => onUpdate(binding.id, { protocol: event.target.value as "tcp" | "udp" })}
                  aria-label="Protocol"
                >
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                </select>
                <input
                  type="number"
                  inputMode="numeric"
                  min={minServerPort}
                  max={maxServerPort}
                  value={binding.hostPort}
                  onChange={(event) => onUpdate(binding.id, { hostPort: event.target.value })}
                  aria-label="Host port"
                  aria-invalid={Boolean(binding.hostPort) && !isValidServerPort(binding.hostPort)}
                  placeholder="8123"
                  required
                />
                <input
                  type="text"
                  value={binding.description}
                  onChange={(event) => onUpdate(binding.id, { description: event.target.value })}
                  aria-label="Description optional"
                  placeholder="Web UI"
                  maxLength={80}
                />
                <Button
                  variant="ghost"
                  iconOnly
                  className="iconDangerButton additionalPortRemoveButton"
                  onClick={() => onRemove(binding.id)}
                  aria-label="Remove port binding"
                  title="Remove port binding"
                >
                  <AppIcon name="trash" />
                </Button>
              </div>
            ))}
          </div>
          {bindings.length === 0 && <div className="additionalPortsEmpty">No additional ports have been added.</div>}
          {!valid && bindings.length > 0 && <span className="fieldError">Each additional binding needs unique, valid host and container ports that do not reuse the server port, Query port, or another port on this node.</span>}
          <Button variant="secondary" className="addPortBindingButton" onClick={onAdd}>
            <AppIcon name="plus" />
            <span>Add port binding</span>
          </Button>
          <p className="fieldHint">Use a host port that is not already assigned to the server port, Query port, or another binding.</p>
          <input
            type="hidden"
            name="additionalPortBindings"
            value={JSON.stringify(bindings.map(({ id: _id, ...binding }) => binding))}
          />
        </div>
      )}
    </section>
  );
}

function ReviewCreateWizardStep({
  node,
  displayName,
  dockerContainer,
  dockerImage,
  serverJar,
  javaArgs,
  minecraftVersion,
  fabricLoaderVersion,
  javaVersion,
  minimumHeapGb,
  maximumHeapGb,
  serverPort,
  queryPort,
  additionalPortBindings,
  acceptEula,
  onEditStep
}: {
  node?: ContextNode;
  displayName: string;
  dockerContainer: string;
  dockerImage: string;
  serverJar: string;
  javaArgs: string;
  minecraftVersion: string;
  fabricLoaderVersion: string;
  javaVersion: 17 | 21 | 25;
  minimumHeapGb: number;
  maximumHeapGb: number;
  serverPort: string;
  queryPort: string;
  additionalPortBindings: CreateWizardPortBinding[];
  acceptEula: boolean;
  onEditStep: (step: 1 | 2 | 3) => void;
}) {
  const additionalCount = additionalPortBindings.length;

  return (
    <>
      <div className="modInstallStepIntro">
        <h3>Review & Create</h3>
        <p>Review your server configuration before creating it.</p>
      </div>

      <div className="createWizardFields reviewWizardFields">
        <ReviewSummaryCard title="Placement & Identity" onEdit={() => onEditStep(1)}>
          <ReviewSummaryItem label="Node" value={nodeDisplayName(node)} icon="node" />
          <ReviewSummaryItem label="Node status" value={nodeStatusTextLabel(node)} tone={node?.status === "online" ? "ok" : "warning"} />
          <ReviewSummaryItem label="Display name" value={displayName || "Missing"} />
          <ReviewSummaryItem label="Docker container name" value={dockerContainer || "Auto-generated"} />
        </ReviewSummaryCard>

        <ReviewSummaryCard title="Runtime" onEdit={() => onEditStep(2)}>
          <ReviewSummaryItem label="Minecraft version" value={minecraftVersion || "Missing"} icon="grass" />
          <ReviewSummaryItem label="Loader" value="Fabric" icon="loader" />
          <ReviewSummaryItem label="Fabric version" value={fabricLoaderVersion || "Missing"} />
          <ReviewSummaryItem label="Java version" value={`Java ${javaVersion}`} icon="java" />
          <ReviewSummaryItem label="Docker image" value={dockerImage || defaultDockerImageForMinecraftVersion(minecraftVersion)} />
          <ReviewSummaryItem label="Server JAR filename" value={serverJar || "Default Fabric launcher"} />
        </ReviewSummaryCard>

        <ReviewSummaryCard title="Resources & Network" onEdit={() => onEditStep(3)}>
          <ReviewSummaryItem label="Minimum heap" value={`${minimumHeapGb} GB`} sublabel="Xms" />
          <ReviewSummaryItem label="Maximum heap" value={`${maximumHeapGb} GB`} sublabel="Xmx" />
          <ReviewSummaryItem label="Java arguments" value={javaArgs || "Default memory args"} />
          <ReviewSummaryItem label="Server port" value={serverPort} sublabel="TCP" />
          <ReviewSummaryItem label="Query port" value={queryPort} sublabel="UDP" />
          <ReviewSummaryItem label="Additional port bindings" value={String(additionalCount)} sublabel={`${additionalCount === 1 ? "binding" : "bindings"} configured`} />
          <ReviewSummaryItem label="EULA" value={acceptEula ? "Accepted" : "Not accepted"} tone={acceptEula ? "ok" : "warning"} />
        </ReviewSummaryCard>

        <section className="reviewInfoCard" aria-labelledby="review-summary-title">
          <strong id="review-summary-title">Summary</strong>
          <div className="reviewInfoCallout">
            <span className="reviewInfoIcon" aria-hidden="true">i</span>
            <p>Once the server is created, ServerSentinel will download the required files, start the container, and launch your Minecraft server. This process may take a few minutes.</p>
          </div>
        </section>
      </div>
    </>
  );
}

function ReviewSummaryCard({
  title,
  onEdit,
  children
}: {
  title: string;
  onEdit: () => void;
  children: ReactNode;
}) {
  return (
    <section className="reviewSummaryCard" aria-labelledby={`review-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
      <div className="reviewSummaryHeader">
        <strong id={`review-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{title}</strong>
        <Button variant="ghost" compact className="reviewEditButton" onClick={onEdit}>
          <AppIcon name="edit" />
          <span>Edit</span>
        </Button>
      </div>
      <div className="reviewSummaryGrid">{children}</div>
    </section>
  );
}

function ReviewSummaryItem({
  label,
  value,
  sublabel,
  icon,
  tone
}: {
  label: string;
  value: string;
  sublabel?: string;
  icon?: "node" | "grass" | "loader" | "java";
  tone?: "ok" | "warning";
}) {
  return (
    <div className="reviewSummaryItem">
      <span>{label}</span>
      <strong className={tone ? `reviewSummaryStatus ${tone}` : ""}>
        {icon === "node" && <ReviewNodeIcon />}
        {icon && icon !== "node" && <RuntimeSummaryIcon icon={icon} />}
        {tone && <span className="runtimeSummaryDot" aria-hidden="true" />}
        {value}
      </strong>
      {sublabel && <small>{sublabel}</small>}
    </div>
  );
}

function ReviewNodeIcon() {
  return (
    <svg className="runtimeSummaryIcon node" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="5" rx="1.5" />
      <rect x="4" y="14" width="16" height="5" rx="1.5" />
      <path d="M7 7.5h.01" />
      <path d="M7 16.5h.01" />
    </svg>
  );
}

const createWizardSteps = [
  { title: "Placement & Identity", subtitle: "Where and what" },
  { title: "Runtime", subtitle: "What to run" },
  { title: "Resources & Network", subtitle: "How it runs" },
  { title: "Review & Create", subtitle: "Confirm and create" }
];

function CreateServerStepper({ activeStep }: { activeStep: number }) {
  return (
    <div className="createWizardStepper" aria-label="Create server progress">
      {createWizardSteps.map((step, index) => {
        const stepNumber = index + 1;
        const completed = stepNumber < activeStep;
        const active = stepNumber === activeStep;
        return (
          <div key={step.title} className={`createWizardStep ${active ? "active" : ""} ${completed ? "completed" : ""}`}>
            <span>{completed ? <AppIcon name="check" /> : stepNumber}</span>
            <div>
              <strong>{step.title}</strong>
              <small>{step.subtitle}</small>
            </div>
            {index < createWizardSteps.length - 1 && <i aria-hidden="true" />}
          </div>
        );
      })}
    </div>
  );
}

function NodeOverviewCard({ node, fallbackMemory }: { node?: ContextNode; fallbackMemory: number }) {
  const totalMemory = node?.totalMemory || fallbackMemory;
  const status = node ? nodeStatusText(node) : "No node selected";
  const uptime = node ? formatNodeUptime(node) : "Select a node";
  const memory = totalMemory ? `${formatBytes(totalMemory)} / ${formatBytes(totalMemory)}` : "Unknown";
  return (
    <section className="createNodeOverview" aria-label="Node overview">
      <strong>Node overview</strong>
      <div className="createNodeOverviewGrid">
        <div className="createNodeOverviewIcon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <rect x="5" y="5" width="14" height="5" rx="1.5" />
            <rect x="5" y="14" width="14" height="5" rx="1.5" />
            <path d="M8 7.5h.01" />
            <path d="M8 16.5h.01" />
            <path d="M12 10v4" />
          </svg>
        </div>
        <div className="createNodeOverviewMetric">
          <span>Status</span>
          <strong className={node?.status === "online" ? "successText" : ""}>{status}</strong>
        </div>
        <div className="createNodeOverviewMetric">
          <span>Uptime</span>
          <strong>{uptime}</strong>
        </div>
        <div className="createNodeOverviewMetric">
          <span>Available memory</span>
          <strong>{memory}</strong>
        </div>
      </div>
      <p>Resources shown are for the selected node.</p>
    </section>
  );
}

function nodeStatusText(node: ContextNode) {
  if (node.status === "online") return "Online";
  if (node.status === "offline") return "Offline";
  return "Unknown";
}

function formatNodeUptime(node: ContextNode) {
  if (node.status !== "online") return "Unavailable";
  const since = node.connectedAt || node.lastSeenAt || node.updatedAt || node.createdAt;
  if (!since) return "Unknown";
  const elapsedMs = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "Unknown";
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
