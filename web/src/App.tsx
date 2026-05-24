import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type AttachedServer = {
  id: string;
  displayName: string;
  directoryLabel: string;
  storageName?: string;
  minecraftVersion?: string;
  loaderVersion?: string;
  installerVersion?: string;
  serverJar?: string;
  dockerContainer?: string;
  dockerImage?: string;
  dockerMountSource?: string;
  dockerPorts?: string;
  javaArgs?: string;
  serverType: "fabric";
  hasDockerContainer: boolean;
};

type AppState = {
  servers: AttachedServer[];
  modrinthApiConfigured: boolean;
  dockerSocketMounted: boolean;
};

type DockerStatus = {
  configured: boolean;
  available: boolean;
  controllable: boolean;
  state: string;
  running?: boolean;
  container?: string;
  message?: string;
};

type ServerStatus = {
  server: AttachedServer;
  docker: DockerStatus;
  fileLogsAvailable: boolean;
  controlAvailable: boolean;
  commandInputAvailable: boolean;
  commandInputMessage: string;
};

type FileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modifiedAt: string;
};

type FileListing = {
  path: string;
  entries: FileEntry[];
};

type ModrinthHit = {
  project_id: string;
  title: string;
  description: string;
  downloads: number;
  icon_url?: string;
};

type FabricVersions = {
  game: Array<{ version: string; stable: boolean }>;
  loader: Array<{ version: string; stable: boolean }>;
  installer: Array<{ version: string; stable: boolean }>;
};

type Notice = {
  id: number;
  type: "success" | "error" | "info";
  text: string;
};

const emptyApp: AppState = {
  servers: [],
  modrinthApiConfigured: false,
  dockerSocketMounted: false
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers as Record<string, string> | undefined) },
    ...init
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with ${response.status}`);
  }
  return payload as T;
}

function parentPath(path: string) {
  if (path === "/") return "/";
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function runtimeLabel(status: ServerStatus | null, dockerSocketMounted: boolean) {
  if (!status) return "Checking runtime";
  if (!dockerSocketMounted) return "Docker socket not mounted";
  if (!status.docker.configured) return "Runtime control not configured";
  if (!status.docker.available) return status.docker.message || "Runtime unavailable";
  if (status.docker.running) return "Runtime running";
  if (status.docker.state && status.docker.state !== "unknown") return `Runtime ${status.docker.state}`;
  return "Runtime status unavailable";
}

function runtimeTone(status: ServerStatus | null, dockerSocketMounted: boolean) {
  if (!status || !dockerSocketMounted || !status.docker.configured || !status.docker.available) return "neutral";
  return status.docker.running ? "running" : "stopped";
}

export default function App() {
  const [appState, setAppState] = useState<AppState>(emptyApp);
  const [activeServerId, setActiveServerId] = useState("");
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [listing, setListing] = useState<FileListing>({ path: "/", entries: [] });
  const [selectedPath, setSelectedPath] = useState("");
  const [editorText, setEditorText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [gameVersion, setGameVersion] = useState("1.21.4");
  const [mods, setMods] = useState<ModrinthHit[]>([]);
  const [fabricVersions, setFabricVersions] = useState<FabricVersions>({ game: [], loader: [], installer: [] });
  const [notice, setNotice] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "files" | "mods" | "settings">("overview");
  const consoleRef = useRef<HTMLDivElement>(null);

  const activeServer = useMemo(
    () => appState.servers.find((server) => server.id === activeServerId) ?? appState.servers[0],
    [activeServerId, appState.servers]
  );

  useEffect(() => {
    refreshApp();
    api<FabricVersions>("/api/fabric/versions").then(setFabricVersions).catch(() => {
      setFabricVersions({
        game: [{ version: "1.21.4", stable: true }, { version: "1.21.1", stable: true }, { version: "1.20.1", stable: true }],
        loader: [],
        installer: []
      });
    });
  }, []);

  useEffect(() => {
    if (!activeServer) return;
    setActiveServerId(activeServer.id);
    setLogs([]);
    setSelectedPath("");
    setEditorText("");
    setDirty(false);
    refreshStatus(activeServer.id);
    loadFiles(activeServer.id, "/");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/console?serverId=${encodeURIComponent(activeServer.id)}`);
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "log") {
        setLogs((current) => [...current.slice(-499), `[${message.source}] ${message.text}`]);
      }
      if (message.type === "unavailable") {
        setLogs([message.message]);
      }
      if (message.type === "empty") {
        setLogs([]);
      }
    };
    socket.onerror = () => setLogs(["Console stream is unavailable."]);
    return () => socket.close();
  }, [activeServer?.id]);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [logs]);

  function notify(type: Notice["type"], text: string) {
    const id = Date.now() + Math.random();
    setNotices((current) => [...current, { id, type, text }]);
    window.setTimeout(() => {
      setNotices((current) => current.filter((candidate) => candidate.id !== id));
    }, 5000);
  }

  async function refreshApp() {
    setNotice("");
    try {
      const next = await api<AppState>("/api/app");
      setAppState(next);
      if (!activeServerId && next.servers[0]) {
        setActiveServerId(next.servers[0].id);
      }
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function refreshStatus(serverId = activeServer?.id) {
    if (!serverId) return;
    try {
      setStatus(await api<ServerStatus>(`/api/servers/${serverId}/status`));
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function attachServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const server = await api<AttachedServer>("/api/servers", {
        method: "POST",
        body: JSON.stringify({
          displayName: form.get("displayName"),
          serverDir: form.get("serverDir"),
          minecraftVersion: form.get("minecraftVersion"),
          loaderVersion: form.get("loaderVersion"),
          installerVersion: form.get("installerVersion"),
          serverJar: form.get("serverJar"),
          dockerContainer: form.get("dockerContainer"),
          dockerImage: form.get("dockerImage"),
          dockerMountSource: form.get("dockerMountSource"),
          dockerPorts: form.get("dockerPorts"),
          javaArgs: form.get("javaArgs"),
          serverPort: form.get("serverPort"),
          acceptEula: form.get("acceptEula") === "on"
        })
      });
      await refreshApp();
      setActiveServerId(server.id);
      setShowCreate(false);
      notify("success", `Created ${server.displayName}`);
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function updateServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeServer) return;
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const server = await api<AttachedServer>(`/api/servers/${activeServer.id}`, {
        method: "PUT",
        body: JSON.stringify({
          displayName: form.get("displayName"),
          minecraftVersion: form.get("minecraftVersion"),
          loaderVersion: form.get("loaderVersion"),
          installerVersion: form.get("installerVersion"),
          serverJar: form.get("serverJar"),
          dockerContainer: form.get("dockerContainer"),
          dockerImage: form.get("dockerImage"),
          dockerPorts: form.get("dockerPorts"),
          javaArgs: form.get("javaArgs"),
          serverPort: form.get("serverPort")
        })
      });
      notify("success", `Updated ${server.displayName}`);
      await refreshApp();
      await refreshStatus(server.id);
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function updateModrinthKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/settings/modrinth", {
        method: "PUT",
        body: JSON.stringify({ modrinthApiKey: form.get("modrinthApiKey") })
      });
      event.currentTarget.reset();
      notify("success", "Modrinth API key saved");
      await refreshApp();
    } catch (error) {
      notify("error", (error as Error).message);
    }
  }

  async function runContainerAction(action: "start" | "stop" | "restart") {
    if (!activeServer) return;
    setNotice("");
    try {
      await api(`/api/servers/${activeServer.id}/${action}`, { method: "POST" });
      await refreshStatus(activeServer.id);
      notify("success", `Sent ${action} request`);
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function sendCommand(event: FormEvent) {
    event.preventDefault();
    setNotice(status?.commandInputMessage ?? "Live stdin commands are not implemented for attached servers in this MVP");
  }

  async function loadFiles(serverId: string, path: string) {
    setNotice("");
    try {
      setListing(await api<FileListing>(`/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`));
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function openFile(path: string) {
    if (!activeServer) return;
    setNotice("");
    try {
      const file = await api<{ path: string; content: string }>(
        `/api/servers/${activeServer.id}/file?path=${encodeURIComponent(path)}`
      );
      setSelectedPath(file.path);
      setEditorText(file.content);
      setDirty(false);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function saveFile() {
    if (!activeServer) return;
    setNotice("");
    try {
      await api(`/api/servers/${activeServer.id}/file`, {
        method: "PUT",
        body: JSON.stringify({ path: selectedPath, content: editorText })
      });
      setDirty(false);
      setNotice(`Saved ${selectedPath}`);
      notify("success", `Saved ${selectedPath}`);
      await loadFiles(activeServer.id, listing.path);
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function searchMods(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    try {
      const result = await api<{ hits: ModrinthHit[] }>(
        `/api/modrinth/search?query=${encodeURIComponent(query)}&gameVersion=${encodeURIComponent(gameVersion)}`
      );
      setMods(result.hits);
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function installMod(projectId: string, title: string) {
    if (!activeServer) return;
    setNotice("");
    try {
      const result = await api<{ filename: string; version: string }>("/api/modrinth/install", {
        method: "POST",
        body: JSON.stringify({ serverId: activeServer.id, projectId, gameVersion })
      });
      setNotice(`Installed ${title} ${result.version} as ${result.filename}`);
      notify("success", `Installed ${title}`);
      await loadFiles(activeServer.id, "/mods");
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  if (!appState.servers.length) {
    return (
      <main className="shell">
        <Notifications notices={notices} />
        <header className="topbar">
          <div>
            <h1>ServerSentinel</h1>
            <p>Managed Fabric server controller</p>
          </div>
          <div className="pill stopped">No servers created</div>
        </header>
        {notice && <div className="notice">{notice}</div>}
        <nav className="tabs">
          <button className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")}>Welcome</button>
          <button className={activeTab === "settings" ? "active" : ""} onClick={() => setActiveTab("settings")}>Settings</button>
        </nav>
        {activeTab === "settings" ? (
          <section className="tabPage settingsPage single">
            <div className="panel settingsPanel">
              <h2>Integrations</h2>
              <ModrinthKeyForm onSubmit={updateModrinthKey} configured={appState.modrinthApiConfigured} />
            </div>
          </section>
        ) : (
          <section className="welcome single">
            <div className="panel welcomePanel">
              <h2>Welcome</h2>
              <p>ServerSentinel creates Fabric server files and can run each server in a separate Docker runtime container.</p>
              <div className="statusGrid">
                <StatusItem label="Docker socket" ok={appState.dockerSocketMounted} good="Connected" bad="Not connected" />
                <StatusItem label="Modrinth API" ok={appState.modrinthApiConfigured} good="Configured" bad="Not configured" />
              </div>
              <p className="muted">Modrinth credentials live on the Settings page and are never sent back to the browser.</p>
              <button onClick={() => setShowCreate(true)}>Create Server</button>
            </div>
          </section>
        )}
        {showCreate && (
          <section className="panel attachPanel">
            <div className="panelHeader">
              <h2>Create Fabric server</h2>
              <button onClick={() => setShowCreate(false)}>Close</button>
            </div>
            <AttachForm onSubmit={attachServer} dockerSocketMounted={appState.dockerSocketMounted} versions={fabricVersions} />
          </section>
        )}
      </main>
    );
  }

  if (!activeServer) {
    return (
      <main className="shell">
        <Notifications notices={notices} />
        <header className="topbar">
          <div>
            <h1>ServerSentinel</h1>
            <p>No active server selected.</p>
          </div>
        </header>
      </main>
    );
  }

  return (
    <main className="shell">
      <Notifications notices={notices} />
      <header className="topbar">
        <div>
          <h1>ServerSentinel</h1>
          <p>Managed Fabric server controller</p>
        </div>
      </header>

      {notice && <div className="notice">{notice}</div>}

      {showCreate && (
        <section className="panel attachPanel">
          <div className="panelHeader">
            <h2>Create Fabric server</h2>
            <button onClick={() => setShowCreate(false)}>Close</button>
          </div>
          <AttachForm onSubmit={attachServer} dockerSocketMounted={appState.dockerSocketMounted} versions={fabricVersions} />
        </section>
      )}

      <section className="serverBar">
        <div className="serverPicker">
          <span className="eyebrow">Active server</span>
          <div className="serverPickerRow">
            <select value={activeServer?.id ?? ""} onChange={(event) => setActiveServerId(event.target.value)} aria-label="Active server">
              {appState.servers.map((server) => (
                <option key={server.id} value={server.id}>{server.displayName}</option>
              ))}
            </select>
            <span className={`runtimeBadge ${runtimeTone(status, appState.dockerSocketMounted)}`}>
              {runtimeLabel(status, appState.dockerSocketMounted)}
            </span>
          </div>
          <span className="serverPath">{activeServer.directoryLabel}</span>
        </div>
        <div className="serverActions">
          <button onClick={() => refreshStatus()}>Refresh</button>
          <button onClick={() => setShowCreate((value) => !value)}>{showCreate ? "Hide create" : "New server"}</button>
        </div>
      </section>

      <nav className="tabs">
        <button className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")}>Overview</button>
        <button className={activeTab === "files" ? "active" : ""} onClick={() => setActiveTab("files")}>Files</button>
        <button className={activeTab === "mods" ? "active" : ""} onClick={() => setActiveTab("mods")}>Mods</button>
        <button className={activeTab === "settings" ? "active" : ""} onClick={() => setActiveTab("settings")}>Settings</button>
      </nav>

      {activeTab === "overview" && (
        <section className="tabPage overviewPage">
          <section className="panel controls">
            <h2>Managed Server</h2>
            <dl className="meta">
              <dt>Directory</dt>
              <dd>{activeServer.directoryLabel}</dd>
              <dt>Version</dt>
              <dd>{activeServer.minecraftVersion || "Manual / unknown"}</dd>
              <dt>Fabric loader</dt>
              <dd>{activeServer.loaderVersion || "Latest stable"}</dd>
              <dt>Docker</dt>
              <dd>{status?.docker.message || status?.docker.container || "Not configured"}</dd>
              <dt>Runtime image</dt>
              <dd>{activeServer.dockerImage || "eclipse-temurin:21-jre"}</dd>
            </dl>
            <div className="buttonRow">
              <button onClick={() => runContainerAction("start")} disabled={!status?.controlAvailable || status.docker.running}>Start</button>
              <button onClick={() => runContainerAction("stop")} disabled={!status?.controlAvailable || !status.docker.running}>Stop</button>
              <button onClick={() => runContainerAction("restart")} disabled={!status?.controlAvailable}>Restart</button>
            </div>
            <form onSubmit={sendCommand} className="commandLine">
              <input placeholder="Live stdin commands are unavailable in this MVP" disabled />
              <button disabled>Send</button>
            </form>
            <p className="muted">{status?.commandInputMessage}</p>
          </section>

          <section className="panel consolePanel">
            <h2>Console Logs</h2>
            <div className="console" ref={consoleRef}>
              {logs.length ? logs.map((line, index) => <pre key={index}>{line}</pre>) : <span className="muted">No log output yet.</span>}
            </div>
            <p className="muted">
              {status?.docker.configured && appState.dockerSocketMounted
                ? "Streaming Docker container logs."
                : "Streaming logs/latest.log when the server writes output."}
            </p>
          </section>
        </section>
      )}

      {activeTab === "files" && (
        <section className="tabPage filesPage">
          <section className="panel filesPanel">
            <div className="panelHeader">
              <h2>Files</h2>
              <code>{listing.path}</code>
            </div>
            <div className="fileActions">
              <button onClick={() => loadFiles(activeServer.id, parentPath(listing.path))} disabled={listing.path === "/"}>Up</button>
              <button onClick={() => loadFiles(activeServer.id, listing.path)}>Refresh</button>
            </div>
            <div className="fileList">
              {listing.entries.map((entry) => (
                <button key={entry.path} className="fileRow" onClick={() => entry.type === "directory" ? loadFiles(activeServer.id, entry.path) : openFile(entry.path)}>
                  <span>{entry.type === "directory" ? "[dir]" : "[file]"} {entry.name}</span>
                  <small>{entry.type === "file" ? formatBytes(entry.size) : ""}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="panel editorPanel">
            <div className="panelHeader">
              <h2>Editor</h2>
              <code>{selectedPath || "No file selected"}</code>
            </div>
            <textarea value={editorText} onChange={(event) => { setEditorText(event.target.value); setDirty(true); }} disabled={!selectedPath} spellCheck={false} />
            <div className="buttonRow">
              <button onClick={saveFile} disabled={!selectedPath || !dirty}>Save</button>
              <span className="muted">Text files up to 2 MiB are supported. Binary editing is intentionally blocked.</span>
            </div>
          </section>
        </section>
      )}

      {activeTab === "mods" && (
        <section className="tabPage">
          <section className="panel modsPanel">
            <div className="panelHeader">
              <h2>Modrinth</h2>
              <span className={appState.modrinthApiConfigured ? "ok" : "muted"}>
                API key {appState.modrinthApiConfigured ? "configured" : "not configured"}
              </span>
            </div>
            <form onSubmit={searchMods} className="modSearch">
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Fabric mods" />
              <input value={gameVersion} onChange={(event) => setGameVersion(event.target.value)} placeholder="Minecraft version" />
              <button disabled={!query.trim() || !gameVersion.trim()}>Search</button>
            </form>
            <div className="mods">
              {mods.map((mod) => (
                <article key={mod.project_id} className="modRow">
                  {mod.icon_url && <img src={mod.icon_url} alt="" />}
                  <div>
                    <strong>{mod.title}</strong>
                    <p>{mod.description}</p>
                    <small>{mod.downloads.toLocaleString()} downloads</small>
                  </div>
                  <button onClick={() => installMod(mod.project_id, mod.title)}>Install</button>
                </article>
              ))}
            </div>
          </section>
        </section>
      )}

      {activeTab === "settings" && (
        <section className="tabPage settingsPage">
          <section className="panel settingsPanel">
            <h2>Integrations</h2>
            <ModrinthKeyForm onSubmit={updateModrinthKey} configured={appState.modrinthApiConfigured} />
          </section>
          <section className="panel settingsPanel">
            <h2>Server Settings</h2>
            <dl className="meta">
              <dt>Server type</dt>
              <dd>Fabric</dd>
              <dt>Jar metadata</dt>
              <dd>{activeServer.serverJar || "Not set"}</dd>
              <dt>Docker socket</dt>
              <dd>{appState.dockerSocketMounted ? "Mounted" : "Not mounted"}</dd>
              <dt>Storage</dt>
              <dd>{activeServer.storageName || "Not set"}</dd>
              <dt>Java args</dt>
              <dd>{activeServer.javaArgs || "-Xms2G -Xmx4G"}</dd>
              <dt>Ports</dt>
              <dd>{activeServer.dockerPorts || "25565:25565/tcp"}</dd>
              <dt>File logs</dt>
              <dd>{status?.fileLogsAvailable ? "logs/latest.log found" : "logs/latest.log not found"}</dd>
              <dt>Control</dt>
              <dd>{status?.controlAvailable ? "Docker container control enabled" : "Not configured"}</dd>
            </dl>
            <ServerEditForm server={activeServer} versions={fabricVersions} onSubmit={updateServer} />
          </section>
        </section>
      )}
    </main>
  );
}

function Notifications({ notices }: { notices: Notice[] }) {
  return (
    <div className="toastRegion">
      {notices.map((notice) => (
        <div key={notice.id} className={`toast ${notice.type}`}>{notice.text}</div>
      ))}
    </div>
  );
}

function StatusItem({
  label,
  ok,
  good,
  bad
}: {
  label: string;
  ok: boolean;
  good: string;
  bad: string;
}) {
  return (
    <div className="statusItem">
      <span>{label}</span>
      <strong className={ok ? "ok" : "warn"}>{ok ? good : bad}</strong>
    </div>
  );
}

function ModrinthKeyForm({
  onSubmit,
  configured
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  configured: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="keyForm">
      <label>
        Modrinth API key
        <input name="modrinthApiKey" type="password" placeholder={configured ? "Configured - enter a new key to replace" : "Paste API key"} required />
      </label>
      <button>Save key</button>
    </form>
  );
}

function ServerEditForm({
  server,
  versions,
  onSubmit
}: {
  server: AttachedServer;
  versions: FabricVersions;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="attachForm">
      <label>
        Display name
        <input name="displayName" defaultValue={server.displayName} required />
      </label>
      <label>
        Minecraft version
        <select name="minecraftVersion" defaultValue={server.minecraftVersion}>
          {versions.game.length ? versions.game.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          )) : <option value={server.minecraftVersion}>{server.minecraftVersion}</option>}
        </select>
      </label>
      <label>
        Fabric loader version
        <select name="loaderVersion" defaultValue={server.loaderVersion ?? ""}>
          <option value="">Latest stable</option>
          {versions.loader.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          ))}
        </select>
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
      <label>
        Memory
        <select name="javaArgs" defaultValue={server.javaArgs || "-Xms2G -Xmx4G"}>
          <option value="-Xms1G -Xmx2G">Small - 2 GB max</option>
          <option value="-Xms2G -Xmx4G">Standard - 4 GB max</option>
          <option value="-Xms4G -Xmx8G">Large - 8 GB max</option>
        </select>
      </label>
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
        <input name="serverJar" defaultValue={server.serverJar || "fabric-server-launch.jar"} />
      </label>
      <label>
        Docker container name
        <input name="dockerContainer" defaultValue={server.dockerContainer || ""} />
      </label>
      <label>
        Port bindings
        <input name="dockerPorts" defaultValue={server.dockerPorts || "25565:25565/tcp"} />
      </label>
      <button>Save server settings</button>
    </form>
  );
}

function AttachForm({
  onSubmit,
  dockerSocketMounted,
  versions
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  dockerSocketMounted: boolean;
  versions: FabricVersions;
}) {
  const runtimeImages = [
    { value: "eclipse-temurin:21-jre", label: "Java 21 runtime (recommended)" },
    { value: "eclipse-temurin:17-jre", label: "Java 17 runtime" },
    { value: "eclipse-temurin:25-jre", label: "Java 25 runtime" }
  ];
  const memoryProfiles = [
    { value: "-Xms1G -Xmx2G", label: "Small - 2 GB max" },
    { value: "-Xms2G -Xmx4G", label: "Standard - 4 GB max" },
    { value: "-Xms4G -Xmx8G", label: "Large - 8 GB max" }
  ];

  return (
    <form onSubmit={onSubmit} className="attachForm">
      <label>
        Display name
        <input name="displayName" placeholder="Survival" required />
      </label>
      <label>
        Minecraft version
        <select name="minecraftVersion" required defaultValue={versions.game[0]?.version ?? "1.21.4"}>
          {versions.game.length ? versions.game.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          )) : <option value="1.21.4">1.21.4</option>}
        </select>
      </label>
      <label>
        Memory
        <select name="javaArgs" defaultValue="-Xms2G -Xmx4G">
          {memoryProfiles.map((profile) => (
            <option key={profile.value} value={profile.value}>{profile.label}</option>
          ))}
        </select>
      </label>
      <label>
        Server port
        <select name="serverPort" defaultValue="25565">
          <option value="25565">25565 - default Minecraft</option>
          <option value="25566">25566</option>
          <option value="25567">25567</option>
          <option value="25568">25568</option>
        </select>
      </label>
      <label className="checkLine">
        <input name="acceptEula" type="checkbox" required />
        I accept the Minecraft EULA for this server.
      </label>
      <details className="advanced">
        <summary>Advanced settings</summary>
        <label>
          Fabric loader version
          <select name="loaderVersion" defaultValue="">
            <option value="">Latest stable</option>
            {versions.loader.map((version) => (
              <option key={version.version} value={version.version}>{version.version}</option>
            ))}
          </select>
        </label>
        <label>
          Fabric installer version
          <select name="installerVersion" defaultValue="">
            <option value="">Latest stable</option>
            {versions.installer.map((version) => (
              <option key={version.version} value={version.version}>{version.version}</option>
            ))}
          </select>
        </label>
        <label>
          Server jar filename
          <input name="serverJar" placeholder="fabric-server-launch.jar" />
        </label>
        <label>
          Docker container name
          <input name="dockerContainer" placeholder="serversentinel-survival" />
        </label>
        <label>
          Docker runtime image
          <select name="dockerImage" defaultValue="eclipse-temurin:21-jre">
            {runtimeImages.map((image) => (
              <option key={image.value} value={image.value}>{image.label}</option>
            ))}
          </select>
        </label>
        <label>
          Port bindings
          <input name="dockerPorts" placeholder="25565:25565/tcp" />
        </label>
      </details>
      <p className="muted">
        Docker socket is {dockerSocketMounted ? "mounted; ServerSentinel can create/start a separate runtime container." : "not mounted; server files will be created, but runtime control needs Docker."}
      </p>
      <button>Create Server</button>
    </form>
  );
}
