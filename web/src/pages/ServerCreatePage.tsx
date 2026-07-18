import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { serverRuntimeDefinitions, serverRuntimeTypes, type ServerRuntimeDefinition, type ServerRuntimeType } from "@serversentinel/contracts";
import { api } from "../api";
import type { ContextNode, FabricVersions, RuntimeVersion } from "../types";
import {
  defaultDockerImageForMinecraftVersion,
  defaultQueryPort,
  defaultServerPort,
  formatBytes,
  isValidServerPort,
  javaMajorVersionForMinecraft,
  maxServerPort,
  minServerPort,
  parseJavaMemoryArgs
} from "../utils/format";
import { isNodeRuntimeUsable, nodeBlockReason } from "../utils/nodes";
import { AppIcon } from "../components/FileTypeIcon";
import { Button } from "../components/UiPrimitives";
import { validateDisplayName, validateDockerContainerName, validateJavaArgs, validateRuntimeJarFilename } from "../utils/validation";
import {
  clampNumber,
  fallbackFabricLoaderVersions,
  findAvailablePort,
  formatNodeUptime,
  makeCreatePortBinding,
  memoryBoundsForNode,
  nodeDisplayName,
  nodeStatusText,
  nodeStatusTextLabel,
  preferredMinecraftVersion,
  runtimeMinecraftOptions,
  usedPortKeysForNode,
  wizardDockerPorts,
  wizardJavaArgs,
  type CreateWizardMinecraftVersion,
  type CreateWizardPortBinding
} from "./serverSettingsHelpers";
import { MemoryNumberInput, MemoryRangeControl } from "./ServerSettingsShared";

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
  const [runtimeType, setRuntimeType] = useState<ServerRuntimeType>("fabric");
  const runtimeDefinition = serverRuntimeDefinitions[runtimeType];
  const [serverJar, setServerJar] = useState(runtimeDefinition.serverJarFilename);
  const [serverJarCustomized, setServerJarCustomized] = useState(false);
  const [activeWizardStep, setActiveWizardStep] = useState<1 | 2 | 3 | 4>(1);
  const [minecraftVersion, setMinecraftVersion] = useState("");
  const [runtimeVersion, setRuntimeVersion] = useState("");
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [runtimeMinecraftVersions, setRuntimeMinecraftVersions] = useState(versions.game);
  const [compatibleRuntimeVersions, setCompatibleRuntimeVersions] = useState<RuntimeVersion[]>([]);
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
  const minecraftOptions = useMemo(() => runtimeMinecraftOptions({ ...versions, game: runtimeMinecraftVersions }, showSnapshots), [runtimeMinecraftVersions, showSnapshots, versions]);
  const runtimeOptions = useMemo(() => {
    const source = compatibleRuntimeVersions.length > 0
      ? compatibleRuntimeVersions
      : runtimeType === "fabric" && versions.loader.length > 0
        ? versions.loader.map((version, index) => ({
            id: version.version,
            runtimeVersion: version.version,
            stable: version.stable,
            recommended: index === 0
          }))
        : runtimeType === "fabric"
          ? fallbackFabricLoaderVersions.map((version) => ({ ...version, runtimeVersion: version.loaderVersion }))
          : [];
    return showSnapshots ? source : source.filter((version) => version.stable !== false);
  }, [compatibleRuntimeVersions, runtimeType, showSnapshots, versions.loader]);
  const recommendedRuntime = runtimeOptions.find((version) => version.recommended) || runtimeOptions.find((version) => version.stable !== false) || runtimeOptions[0];
  const summaryJavaVersion = javaMajorVersionForMinecraft(minecraftVersion);
  const runtimeCompatible = runtimeDefinition.managedProvisioning && Boolean(minecraftVersion && runtimeVersion);
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
    let cancelled = false;
    api<{ runtimeType: ServerRuntimeType; versions: Array<{ id: string; type?: "release" | "snapshot" | "unknown"; supported?: boolean; recommended?: boolean }> }>(`/api/runtime/${runtimeType}/minecraft-versions`)
      .then((result) => {
        if (!cancelled) {
          setRuntimeMinecraftVersions(result.versions.map((version) => ({
            version: version.id,
            stable: version.type === "release" && version.supported !== false,
            recommended: version.recommended,
            type: version.type ?? "unknown"
          })));
        }
      })
      .catch(() => {
        if (!cancelled) setRuntimeMinecraftVersions(runtimeType === "fabric" ? versions.game : []);
      });
    return () => {
      cancelled = true;
    };
  }, [runtimeType, versions.game]);

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
      setCompatibleRuntimeVersions([]);
      return;
    }
    let cancelled = false;
    api<{ runtimeType: ServerRuntimeType; minecraftVersion: string; runtimeVersions: RuntimeVersion[] }>(`/api/runtime/${runtimeType}/versions?minecraftVersion=${encodeURIComponent(minecraftVersion)}`)
      .then((result) => {
        if (!cancelled) setCompatibleRuntimeVersions(result.runtimeVersions);
      })
      .catch(() => {
        if (!cancelled) setCompatibleRuntimeVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [minecraftVersion, runtimeType]);

  useEffect(() => {
    if (runtimeOptions.some((version) => version.runtimeVersion === runtimeVersion)) return;
    setRuntimeVersion(recommendedRuntime?.runtimeVersion || runtimeOptions[0]?.runtimeVersion || "");
  }, [recommendedRuntime, runtimeOptions, runtimeVersion]);

  useEffect(() => {
    if (!serverJarCustomized) setServerJar(runtimeDefinition.serverJarFilename);
  }, [runtimeDefinition.serverJarFilename, serverJarCustomized]);

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
            runtimeType={runtimeType}
            runtimeDefinition={runtimeDefinition}
            minecraftVersion={minecraftVersion}
            minecraftOptions={minecraftOptions}
            runtimeVersion={runtimeVersion}
            runtimeOptions={runtimeOptions}
            recommendedRuntimeVersion={recommendedRuntime?.runtimeVersion || ""}
            showSnapshots={showSnapshots}
            javaVersion={summaryJavaVersion}
            runtimeCompatible={runtimeCompatible}
            onRuntimeTypeChange={(value) => {
              setRuntimeType(value);
              setRuntimeMinecraftVersions([]);
              setCompatibleRuntimeVersions([]);
              setMinecraftVersion("");
              setRuntimeVersion("");
            }}
            onMinecraftVersionChange={setMinecraftVersion}
            onRuntimeVersionChange={setRuntimeVersion}
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
            onServerJarChange={(value) => {
              setServerJarCustomized(true);
              setServerJar(value);
            }}
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
            runtimeDefinition={runtimeDefinition}
            displayName={displayName}
            dockerContainer={dockerContainer}
            dockerImage={dockerImage}
            serverJar={serverJar}
            javaArgs={javaArgs}
            minecraftVersion={minecraftVersion}
            runtimeVersion={runtimeVersion}
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
              } : undefined} disabled={activeWizardStep === 3 ? !resourcesReady : provisioning} title={activeWizardStep === 3 && !resourcesReady ? resourcesBlockedReason || "Complete resources and network settings before continuing." : undefined} reserveLabel={activeWizardStep === 3 ? <><span>Next: Review & Create</span><AppIcon name="chevronRight" /></> : <><AppIcon name="server" /><span>Create Server</span></>}>
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
      <input type="hidden" name="runtimeType" value={runtimeType} />
      <input type="hidden" name="minecraftVersion" value={minecraftVersion} />
      <input type="hidden" name="runtimeVersion" value={runtimeVersion} />
      {runtimeType === "fabric" && <input type="hidden" name="loaderVersion" value={runtimeVersion} />}
      <input type="hidden" name="serverJar" value={serverJar} />
      <input type="hidden" name="javaArgs" value={javaArgs} />
      <input type="hidden" name="serverPort" value={serverPort} />
      <input type="hidden" name="queryPort" value={queryPort} />
      <input type="hidden" name="dockerPorts" value={dockerPorts} />
      {acceptEula && <input type="hidden" name="acceptEula" value="on" />}
    </form>
  );
}

export function RuntimeWizardStep({
  runtimeType,
  runtimeDefinition,
  minecraftVersion,
  minecraftOptions,
  runtimeVersion,
  runtimeOptions,
  recommendedRuntimeVersion,
  showSnapshots,
  javaVersion,
  runtimeCompatible,
  onRuntimeTypeChange,
  onMinecraftVersionChange,
  onRuntimeVersionChange,
  onShowSnapshotsChange
}: {
  runtimeType: ServerRuntimeType;
  runtimeDefinition: ServerRuntimeDefinition;
  minecraftVersion: string;
  minecraftOptions: CreateWizardMinecraftVersion[];
  runtimeVersion: string;
  runtimeOptions: RuntimeVersion[];
  recommendedRuntimeVersion: string;
  showSnapshots: boolean;
  javaVersion: 17 | 21 | 25;
  runtimeCompatible: boolean;
  onRuntimeTypeChange: (value: ServerRuntimeType) => void;
  onMinecraftVersionChange: (value: string) => void;
  onRuntimeVersionChange: (value: string) => void;
  onShowSnapshotsChange: (value: boolean) => void;
}) {
  return (
    <>
      <div className="modInstallStepIntro">
        <h3>Runtime</h3>
        <p>Select the Minecraft version and server runtime you want to run.</p>
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
          {runtimeOptions.length === 0 && (
            <span className="fieldHint" role="status">
              No stable {runtimeDefinition.displayName} build is available for this Minecraft version. Choose another Minecraft version or enable development builds.
            </span>
          )}
        </div>

        <section className="runtimeLoaderSection" aria-labelledby="runtime-loader-title">
          <div>
            <strong id="runtime-loader-title">Server runtime</strong>
            <span className="fieldHint">Availability is controlled by each runtime provider.</span>
          </div>
          {serverRuntimeTypes.map((candidateType) => {
            const candidate = serverRuntimeDefinitions[candidateType];
            const selected = candidateType === runtimeType;
            return (
              <button
                key={candidateType}
                type="button"
                className={`runtimeLoaderCard${selected ? " selected" : ""}`}
                aria-pressed={selected}
                disabled={!candidate.managedProvisioning}
                title={candidate.managedProvisioning ? `Use ${candidate.displayName}` : `${candidate.displayName} provisioning is planned but not enabled yet`}
                onClick={() => onRuntimeTypeChange(candidateType)}
              >
                <span className="fabricLoaderMark" aria-hidden="true">
                  {candidateType === "fabric" ? (
                    <svg viewBox="0 0 13 14" shapeRendering="crispEdges">
                      <path className="fabricLogoOutline" d="M7 0h1v1h1v1h1v1h1v1h1v1h1v3h-1v1h-1v1h-1v1H9v1H8v1H6v1H4v-1H3v-1H2v-1H1v-1H0V8h1V7h1V6h1V5h1V4h1V3h1V1h1Z" />
                      <path className="fabricLogoMain" d="M7 1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1H9v1H8v1H7v1H5v1H4v-1H3v-1H2v-1H1V8h1V7h1V6h1V5h1V4h1V2h1Z" />
                      <path className="fabricLogoHighlight" d="M7 1h1v1h1v1h1v1h1v1h-1v1H9V5H8V4H7V3H6V2h1Z" />
                      <path className="fabricLogoShade" d="M11 5h1v2h-1v1h-1v1H9v1H8v1H7v1H5v1H4v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1Z" />
                      <path className="fabricLogoThread" d="M10 3h1v1h1v1h-1V4h-1ZM11 7h1v1h-1ZM9 9h1v1H9Z" />
                    </svg>
                  ) : <AppIcon name="server" />}
                </span>
                <span className="runtimeLoaderCopy">
                  <span>
                    <strong>{candidate.displayName}</strong>
                    <mark className={`settingsStatus ${candidate.managedProvisioning ? "ready" : "neutral"}`}>
                      {candidate.managedProvisioning ? selected ? "Selected" : "Available" : "Planned"}
                    </mark>
                  </span>
                  <small>{candidate.description}</small>
                </span>
                {selected && <span className="runtimeLoaderCheck" aria-hidden="true"><AppIcon name="check" /></span>}
              </button>
            );
          })}
        </section>

        <div className="createWizardField">
          <label htmlFor="create-runtime-version">{runtimeDefinition.versionLabel}</label>
          <span className="fieldHint">Choose the {runtimeDefinition.displayName} version compatible with the selected Minecraft version.</span>
          <select
            id="create-runtime-version"
            name="runtimeVersion"
            value={runtimeVersion}
            onChange={(event) => onRuntimeVersionChange(event.target.value)}
            required
          >
            {runtimeOptions.map((version) => (
              <option key={version.id || version.runtimeVersion} value={version.runtimeVersion}>
                {version.runtimeVersion}{version.runtimeVersion === recommendedRuntimeVersion ? " (Recommended)" : ""}
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
          runtimeDefinition={runtimeDefinition}
          minecraftVersion={minecraftVersion}
          runtimeVersion={runtimeVersion}
          javaVersion={javaVersion}
          runtimeCompatible={runtimeCompatible}
        />
      </div>
    </>
  );
}

function RuntimeSummary({
  runtimeDefinition,
  minecraftVersion,
  runtimeVersion,
  javaVersion,
  runtimeCompatible
}: {
  runtimeDefinition: ServerRuntimeDefinition;
  minecraftVersion: string;
  runtimeVersion: string;
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
        <RuntimeSummaryItem label="Server runtime" value={runtimeDefinition.displayName} icon="loader" />
        <RuntimeSummaryItem label={runtimeDefinition.versionLabel} value={runtimeVersion || "Choose version"} />
        <RuntimeSummaryItem label="Java version" value={`Java ${javaVersion}`} icon="java" />
        <RuntimeSummaryItem label="Server JAR source" value={runtimeDefinition.serverJarFilename} />
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
            helper="Used by serverSENTINEL for player metrics."
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
                <small>The resolved runtime artifact will be saved with this local filename.</small>
                <input
                  id="create-server-jar"
                  type="text"
                  value={serverJar}
                  onChange={(event) => onServerJarChange(event.target.value)}
                  placeholder="server.jar"
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
  runtimeDefinition,
  displayName,
  dockerContainer,
  dockerImage,
  serverJar,
  javaArgs,
  minecraftVersion,
  runtimeVersion,
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
  runtimeDefinition: ServerRuntimeDefinition;
  displayName: string;
  dockerContainer: string;
  dockerImage: string;
  serverJar: string;
  javaArgs: string;
  minecraftVersion: string;
  runtimeVersion: string;
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
          <ReviewSummaryItem label="Server runtime" value={runtimeDefinition.displayName} icon="loader" />
          <ReviewSummaryItem label={runtimeDefinition.versionLabel} value={runtimeVersion || "Missing"} />
          <ReviewSummaryItem label="Java version" value={`Java ${javaVersion}`} icon="java" />
          <ReviewSummaryItem label="Docker image" value={dockerImage || defaultDockerImageForMinecraftVersion(minecraftVersion)} />
          <ReviewSummaryItem label="Server JAR filename" value={serverJar || runtimeDefinition.serverJarFilename} />
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
            <p>Once the server is created, serverSENTINEL will download the required files, start the container, and launch your Minecraft server. This process may take a few minutes.</p>
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
