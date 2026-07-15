import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import type { FabricVersions, ManagedServer } from "../types";
import {
  defaultDockerImageForMinecraftVersion,
  fabricLoaderVersionInfo,
  isValidServerPort,
  maxServerPort,
  memoryArgs,
  minecraftVersionInfo,
  minServerPort,
  parseJavaMemoryArgs,
  parseMaxMemoryGb,
  versionSourceLabel,
  versionValue
} from "../utils/format";
import { AppIcon } from "../components/FileTypeIcon";
import { Button } from "../components/UiPrimitives";
import {
  clampNumber,
  formatManagedPortBindings,
  memoryBoundsForNode,
  parseAdditionalPortBindings,
  portBindingId,
  queryPortForServer,
  serverPortForServer,
  wizardJavaArgs,
  type PortBindingRow
} from "./serverSettingsHelpers";
import { MemoryNumberInput, MemoryRangeControl } from "./ServerSettingsShared";

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
    <section className="minecraftPortsSection" aria-label="Minecraft network ports">
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
          <span className="fieldHint">UDP port used by serverSENTINEL for quiet player metrics.</span>
        </label>
      </div>
      {!serverPortValid && <span className="fieldError">Use a server port from {minServerPort} to {maxServerPort}.</span>}
      {!queryPortValid && <span className="fieldError">Use a Query port from {minServerPort} to {maxServerPort}.</span>}
      {portConflict && <span className="fieldError">Server port and Query port must be different.</span>}
    </section>
  );
}

export function ServerEditForm({
  server,
  versions,
  totalMemory,
  onSubmit,
  dangerZone,
  disabledReason = "",
  disabled = false
}: {
  server: ManagedServer;
  versions: FabricVersions;
  totalMemory: number;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  dangerZone?: ReactNode;
  disabledReason?: string;
  disabled?: boolean;
}) {
  const initialJavaArgs = server.javaArgs || memoryArgs(parseMaxMemoryGb(server.javaArgs));
  const initialMemory = parseJavaMemoryArgs(initialJavaArgs);
  const initialMaximumHeapGb = parseMaxMemoryGb(initialJavaArgs);
  const initialMinimumHeapGb = initialMemory.xmsGb ?? initialMaximumHeapGb;
  const memoryBounds = useMemo(() => memoryBoundsForNode(totalMemory), [totalMemory]);
  const formId = `server-settings-form-${server.id}`;
  const [displayName, setDisplayName] = useState(server.displayName);
  const [minecraftVersion, setMinecraftVersion] = useState(server.runtimeProfile.minecraftVersion);
  const [loaderVersion, setLoaderVersion] = useState(server.runtimeProfile.loaderVersion ?? "");
  const [dockerImage, setDockerImage] = useState(server.dockerImage || defaultDockerImageForMinecraftVersion(server.runtimeProfile.minecraftVersion));
  const [serverJar, setServerJar] = useState(server.runtimeProfile.jarArtifact.filename || "fabric-server-launch.jar");
  const [dockerContainer, setDockerContainer] = useState(server.dockerContainer || "");
  const [minimumHeapGb, setMinimumHeapGb] = useState(() => clampNumber(initialMinimumHeapGb, memoryBounds.min, memoryBounds.max));
  const [maximumHeapGb, setMaximumHeapGb] = useState(() => clampNumber(initialMaximumHeapGb, memoryBounds.min, memoryBounds.max));
  const [javaArgs, setJavaArgs] = useState(() => wizardJavaArgs(
    clampNumber(initialMinimumHeapGb, memoryBounds.min, memoryBounds.max),
    clampNumber(initialMaximumHeapGb, memoryBounds.min, memoryBounds.max),
    initialJavaArgs
  ));
  const [serverPort, setServerPort] = useState(() => serverPortForServer(server));
  const [queryPort, setQueryPort] = useState(() => queryPortForServer(server));
  const [resetVersion, setResetVersion] = useState(0);
  const detectedMinecraftVersion = minecraftVersionInfo(server);
  const detectedFabricLoaderVersion = fabricLoaderVersionInfo(server);
  const serverPortValid = isValidServerPort(serverPort);
  const queryPortValid = isValidServerPort(queryPort);
  const portConflict = serverPort === queryPort;
  const memoryWarning = maximumHeapGb > memoryBounds.max * 0.8;
  const currentMinecraftVersionListed = versions.game.some((version) => version.version === minecraftVersion);
  const currentLoaderVersionListed = !loaderVersion || versions.loader.some((version) => version.version === loaderVersion);

  useEffect(() => {
    resetFormState();
  }, [server.id]);

  useEffect(() => {
    setServerPort(serverPortForServer(server));
    setQueryPort(queryPortForServer(server));
  }, [server.id, server.dockerPorts, server.managedPorts]);

  useEffect(() => {
    setMinimumHeapGb((current) => Math.min(clampNumber(current, memoryBounds.min, memoryBounds.max), maximumHeapGb));
    setMaximumHeapGb((current) => Math.max(clampNumber(current, memoryBounds.min, memoryBounds.max), minimumHeapGb));
  }, [maximumHeapGb, memoryBounds.max, memoryBounds.min, minimumHeapGb]);

  function resetFormState() {
    const nextJavaArgs = server.javaArgs || memoryArgs(parseMaxMemoryGb(server.javaArgs));
    const nextMemory = parseJavaMemoryArgs(nextJavaArgs);
    const nextMaximum = clampNumber(nextMemory.xmxGb ?? parseMaxMemoryGb(nextJavaArgs), memoryBounds.min, memoryBounds.max);
    const nextMinimum = clampNumber(nextMemory.xmsGb ?? nextMaximum, memoryBounds.min, nextMaximum);
    setDisplayName(server.displayName);
    setMinecraftVersion(server.runtimeProfile.minecraftVersion);
    setLoaderVersion(server.runtimeProfile.loaderVersion ?? "");
    setDockerImage(server.dockerImage || defaultDockerImageForMinecraftVersion(server.runtimeProfile.minecraftVersion));
    setServerJar(server.runtimeProfile.jarArtifact.filename || "fabric-server-launch.jar");
    setDockerContainer(server.dockerContainer || "");
    setMinimumHeapGb(nextMinimum);
    setMaximumHeapGb(nextMaximum);
    setJavaArgs(wizardJavaArgs(nextMinimum, nextMaximum, nextJavaArgs));
    setServerPort(serverPortForServer(server));
    setQueryPort(queryPortForServer(server));
    setResetVersion((current) => current + 1);
  }

  function updateMinimumHeap(value: number) {
    const next = clampNumber(Math.round(value), memoryBounds.min, Math.min(memoryBounds.max, maximumHeapGb));
    setMinimumHeapGb(next);
    setJavaArgs((current) => wizardJavaArgs(next, maximumHeapGb, current));
  }

  function updateMaximumHeap(value: number) {
    const next = clampNumber(Math.round(value), Math.max(memoryBounds.min, minimumHeapGb), memoryBounds.max);
    setMaximumHeapGb(next);
    setJavaArgs((current) => wizardJavaArgs(minimumHeapGb, next, current));
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

  return (
    <div className="serverPropertiesWorkspace">
      <form id={formId} onSubmit={onSubmit} className="serverPropertiesForm">
        {disabled && disabledReason && (
          <div className="propertiesLockBanner" role="status">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="5" y="10" width="14" height="10" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
            <span>{disabledReason}</span>
          </div>
        )}
        <fieldset disabled={disabled}>
          <section className="propertiesSettingsSurface">
            <div className="propertiesSection" aria-labelledby="properties-general-title">
              <h2 id="properties-general-title">General</h2>
              <div className="propertiesFieldGrid three">
                <label>
                  Display name
                  <input name="displayName" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={80} />
                </label>
                <label>
                  Minecraft version
                  <select name="minecraftVersion" value={minecraftVersion} onChange={(event) => setMinecraftVersion(event.target.value)}>
                    {minecraftVersion && !currentMinecraftVersionListed && <option value={minecraftVersion}>{minecraftVersion}</option>}
                    {versions.game.length ? versions.game.map((version) => (
                      <option key={version.version} value={version.version}>{version.version}</option>
                    )) : <option value={server.runtimeProfile.minecraftVersion}>{server.runtimeProfile.minecraftVersion}</option>}
                  </select>
                  <span className="fieldHint">Current: {versionValue(detectedMinecraftVersion)} ({versionSourceLabel(detectedMinecraftVersion.source)})</span>
                </label>
                <label>
                  Fabric loader version
                  <select name="loaderVersion" value={loaderVersion} onChange={(event) => setLoaderVersion(event.target.value)}>
                    <option value="">Latest stable</option>
                    {loaderVersion && !currentLoaderVersionListed && <option value={loaderVersion}>{loaderVersion}</option>}
                    {versions.loader.map((version) => (
                      <option key={version.version} value={version.version}>{version.version}</option>
                    ))}
                  </select>
                  <span className="fieldHint">Current: {versionValue(detectedFabricLoaderVersion)} ({versionSourceLabel(detectedFabricLoaderVersion.source)})</span>
                </label>
              </div>
            </div>

            <div className="propertiesSection" aria-labelledby="properties-resources-title">
              <h2 id="properties-resources-title">Resources</h2>
              <section className="resourceStepSection propertiesMemorySection" aria-label="Minecraft memory">
                <div className="memoryRangeLayout">
                  <MemoryRangeControl
                    bounds={memoryBounds}
                    minimumHeapGb={minimumHeapGb}
                    maximumHeapGb={maximumHeapGb}
                    onMinimumHeapChange={updateMinimumHeap}
                    onMaximumHeapChange={updateMaximumHeap}
                  />
                  <div className="memoryNumberFields">
                    <MemoryNumberInput
                      id="edit-minimum-heap"
                      label="Minimum heap (Xms)"
                      value={minimumHeapGb}
                      min={memoryBounds.min}
                      max={maximumHeapGb}
                      onChange={updateMinimumHeap}
                    />
                    <span className="memoryHeapDivider" aria-hidden="true">/</span>
                    <MemoryNumberInput
                      id="edit-maximum-heap"
                      label="Maximum heap (Xmx)"
                      value={maximumHeapGb}
                      min={minimumHeapGb}
                      max={memoryBounds.max}
                      onChange={updateMaximumHeap}
                    />
                  </div>
                </div>
                <div className="memoryRangeMeta">
                  <span>Recommended: {memoryBounds.recommendedMin} GB - {memoryBounds.recommendedMax} GB</span>
                  <span>Total available: {memoryBounds.max} GB</span>
                </div>
                {memoryWarning && <span className="fieldError">Leave some RAM for the host. Using nearly all memory may cause instability.</span>}
                <input type="hidden" name="javaArgs" value={javaArgs} />
              </section>
            </div>

            <div className="propertiesSection" aria-labelledby="properties-network-title">
              <h2 id="properties-network-title">Network</h2>
              <MinecraftPortsSection
                serverPort={serverPort}
                queryPort={queryPort}
                onServerPortChange={setServerPort}
                onQueryPortChange={setQueryPort}
                serverPortValid={serverPortValid}
                queryPortValid={queryPortValid}
                portConflict={portConflict}
              />
            </div>

            <details className="resourceDisclosure advancedResourceDisclosure propertiesDisclosure">
              <summary>
                <strong>Advanced</strong>
              </summary>
              <div className="advancedResourceBody propertiesAdvancedBody">
                <div className="propertiesFieldGrid two">
                  <label>
                    Docker runtime image
                    <select name="dockerImage" value={dockerImage} onChange={(event) => setDockerImage(event.target.value)}>
                      <option value="eclipse-temurin:21-jre">Java 21 runtime</option>
                      <option value="eclipse-temurin:17-jre">Java 17 runtime</option>
                      <option value="eclipse-temurin:25-jre">Java 25 runtime</option>
                    </select>
                  </label>
                  <label>
                    Server jar filename
                    <input name="serverJar" value={serverJar} onChange={(event) => setServerJar(event.target.value)} pattern="^[^\\/]+\.jar$" title="Use a local .jar filename, not a path." />
                  </label>
                  <label className="propertiesFieldWide">
                    Docker container name
                    <input
                      name="dockerContainer"
                      value={dockerContainer}
                      onChange={(event) => setDockerContainer(event.target.value)}
                      pattern="^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$"
                      title="Use letters, numbers, dots, dashes, and underscores."
                    />
                  </label>
                  <label className="propertiesFieldWide" htmlFor="edit-java-args">
                    Java arguments
                    <textarea
                      id="edit-java-args"
                      className="javaArgsInput"
                      value={javaArgs}
                      onChange={(event) => updateJavaArgs(event.target.value)}
                      rows={4}
                      spellCheck={false}
                    />
                  </label>
                </div>
                <div className="propertiesAdvancedPorts">
                  <AdditionalPortBindingsEditor key={`${server.id}-${resetVersion}`} initialValue={server.dockerPorts} serverPort={serverPort} queryPort={queryPort} />
                </div>
              </div>
            </details>
          </section>
        </fieldset>
        <div className="propertiesActionBar">
          <div className="propertiesActionButtons">
            <Button variant="secondary" onClick={resetFormState} disabled={disabled}>
              Discard changes
            </Button>
            <Button type="submit" disabled={disabled || !serverPortValid || !queryPortValid || portConflict}>
              Save changes
            </Button>
          </div>
        </div>
      </form>

      {dangerZone && <div className="propertiesDangerZone">{dangerZone}</div>}
    </div>
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
    <section className="propertiesSideCard dangerPanel">
      <h2>Danger zone</h2>
      <p className="muted">Deleting a server is permanent and cannot be undone.</p>
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
        <Button type="submit" variant="critical" disabled={!deleteConfirmed}>Delete server</Button>
        </fieldset>
      </form>
    </section>
  );
}

