import type { FileListing, FileEntry, InstalledMod, ManagedServer, ModrinthHit, ResourceSample, ScheduledExecution, ServerOverviewData, ServerStatus } from './types';

const demoStartedAt = Date.now();

export const demoServerId = "demo-survival";

export const initialDemoSchedules: ScheduledExecution[] = [{
  id: "demo-schedule-backup",
  name: "Nightly backup",
  cron: "0 4 * * *",
  commands: ["save-all", "say Backup complete"],
  onlyWhenNoPlayers: true,
  enabled: true,
  createdAt: new Date(demoStartedAt - 86_400_000).toISOString(),
  updatedAt: new Date(demoStartedAt - 3_600_000).toISOString(),
  lastRunAt: new Date(demoStartedAt - 18_000_000).toISOString(),
  lastStatus: "succeeded",
  lastMessage: "Demo execution completed"
}];

export const initialDemoMods: InstalledMod[] = [
  {
    filename: "distanthorizons-3.0.3-b-26.1.2-fabric-neoforge.jar",
    displayName: "Distant Horizons",
    description: "Level-of-detail rendering for long distance terrain.",
    enabled: true,
    size: 4512000,
    modifiedAt: new Date(demoStartedAt - 172_800_000).toISOString(),
    compatibility: { status: "compatible", compatible: true, reason: "Compatible with this server", matchedGameVersions: ["26.1.2"] },
    versionInfo: {
      currentVersion: "3.0.3-b-26.1.2",
      currentChannel: "release",
      latestVersion: "3.0.3-b-26.1.2",
      latestChannel: "release",
      upToDate: true
    },
    modrinth: {
      projectId: "distant-horizons",
      versionId: "dh-123",
      filename: "distanthorizons-3.0.3-b-26.1.2-fabric-neoforge.jar",
      versionNumber: "3.0.3-b-26.1.2",
      gameVersions: ["26.1.2"],
      loaders: ["fabric"],
      installedAt: new Date(demoStartedAt - 172_800_000).toISOString(),
      installedWithForceIncompatible: false
    }
  },
  {
    filename: "fabric-api-0.149.1+26.1.2.jar",
    displayName: "Fabric API",
    description: "Core library required for Fabric mods.",
    enabled: true,
    size: 2840576,
    modifiedAt: new Date(demoStartedAt - 172_800_000).toISOString(),
    compatibility: { status: "compatible", compatible: true, reason: "Compatible with this server", matchedGameVersions: ["26.1.2"] },
    versionInfo: {
      currentVersion: "0.149.1+26.1.2",
      currentChannel: "release",
      latestVersion: "0.149.1+26.1.2",
      latestChannel: "release",
      upToDate: true
    },
    modrinth: {
      projectId: "fabric-api",
      versionId: "fapi-123",
      filename: "fabric-api-0.149.1+26.1.2.jar",
      versionNumber: "0.149.1+26.1.2",
      gameVersions: ["26.1.2"],
      loaders: ["fabric"],
      installedAt: new Date(demoStartedAt - 172_800_000).toISOString(),
      installedWithForceIncompatible: false
    }
  },
  {
    filename: "krypton-0.3.0.jar",
    displayName: "Krypton",
    description: "Improves networking performance.",
    enabled: true,
    size: 98000,
    modifiedAt: new Date(demoStartedAt - 172_800_000).toISOString(),
    compatibility: { status: "compatible", compatible: true, reason: "Compatible with this server", matchedGameVersions: ["26.1.2"] },
    versionInfo: {
      currentVersion: "0.3.0",
      currentChannel: "release",
      latestVersion: "0.3.0",
      latestChannel: "release",
      upToDate: true
    },
    modrinth: {
      projectId: "krypton",
      versionId: "kry-123",
      filename: "krypton-0.3.0.jar",
      versionNumber: "0.3.0",
      gameVersions: ["26.1.2"],
      loaders: ["fabric"],
      installedAt: new Date(demoStartedAt - 172_800_000).toISOString(),
      installedWithForceIncompatible: false
    }
  },
  {
    filename: "sodium-fabric-0.5.8+mc26.1.2.jar",
    displayName: "Sodium",
    description: "Graphics optimization mod.",
    enabled: true,
    size: 1234567,
    modifiedAt: new Date(demoStartedAt - 86_400_000).toISOString(),
    compatibility: { status: "compatible", compatible: true, reason: "Compatible with this server", matchedGameVersions: ["26.1.2"] },
    versionInfo: {
      currentVersion: "0.5.8",
      currentChannel: "release",
      latestVersion: "0.6.0",
      latestChannel: "release",
      upToDate: false
    },
    modrinth: {
      projectId: "sodium",
      versionId: "sod-123",
      filename: "sodium-fabric-0.5.8+mc26.1.2.jar",
      versionNumber: "0.5.8",
      gameVersions: ["26.1.2"],
      loaders: ["fabric"],
      installedAt: new Date(demoStartedAt - 86_400_000).toISOString(),
      installedWithForceIncompatible: false
    }
  },
  {
    filename: "lithium-fabric-0.2.4.2_mc26.1.2.jar",
    displayName: "Lithium",
    description: "General server performance improvements.",
    enabled: true,
    size: 734208,
    modifiedAt: new Date(demoStartedAt - 86_400_000).toISOString(),
    compatibility: { status: "compatible", compatible: true, reason: "Compatible with this server", matchedGameVersions: ["26.1.2"] },
    versionInfo: {
      currentVersion: "0.2.4.2+mc26.1.2",
      currentChannel: "release",
      latestVersion: "0.2.4.2+mc26.1.2",
      latestChannel: "release",
      upToDate: true
    },
    modrinth: {
      projectId: "lithium",
      versionId: "lit-123",
      filename: "lithium-fabric-0.2.4.2_mc26.1.2.jar",
      versionNumber: "0.2.4.2+mc26.1.2",
      gameVersions: ["26.1.2"],
      loaders: ["fabric"],
      installedAt: new Date(demoStartedAt - 86_400_000).toISOString(),
      installedWithForceIncompatible: false
    }
  }
];

export const demoSearchResults: ModrinthHit[] = [
  {
    project_id: "demo-sodium",
    title: "Sodium",
    description: "Client and server rendering performance mod shown here as demo data.",
    downloads: 42_500_000,
    date_modified: new Date(demoStartedAt - 2 * 86_400_000).toISOString(),
    compatibility: {
      status: "compatible",
      compatible: true,
      reason: "Compatible server-side Fabric mod",
      serverSide: "required",
      clientSide: "optional"
    },
    server_side: "required",
    client_side: "optional"
  },
  {
    project_id: "demo-ferritecore",
    title: "FerriteCore",
    description: "Memory optimization mod included in the simulated Modrinth search.",
    downloads: 18_250_000,
    date_modified: new Date(demoStartedAt - 7 * 86_400_000).toISOString(),
    compatibility: {
      status: "compatible",
      compatible: true,
      reason: "Compatible server-side Fabric mod",
      serverSide: "optional",
      clientSide: "optional"
    },
    server_side: "optional",
    client_side: "optional"
  },
  {
    project_id: "demo-iris",
    title: "Iris Shaders",
    description: "A modern shaders mod for Minecraft. It is a client-only mod and cannot run on a server.",
    downloads: 25_100_000,
    date_modified: new Date(demoStartedAt - 3 * 86_400_000).toISOString(),
    compatibility: {
      status: "incompatible",
      compatible: false,
      reason: "Client-only mod; server-side support is unsupported",
      serverSide: "unsupported",
      clientSide: "required"
    },
    server_side: "unsupported",
    client_side: "required"
  },
  {
    project_id: "demo-unknown-side",
    title: "Mystery Mod",
    description: "A mod whose server-side compatibility could not be verified.",
    downloads: 500_000,
    date_modified: new Date(demoStartedAt - 12 * 86_400_000).toISOString(),
    compatibility: {
      status: "unknown",
      compatible: false,
      reason: "Server-side support could not be verified",
      serverSide: "unknown",
      clientSide: "unknown"
    },
    server_side: "unknown",
    client_side: "unknown"
  },
  {
    project_id: "demo-clumps",
    title: "Clumps",
    description: "Groups XP orbs together to reduce server work in busy worlds.",
    downloads: 31_100_000,
    date_modified: new Date(demoStartedAt - 14 * 86_400_000).toISOString(),
    compatibility: {
      status: "no_minecraft_version",
      compatible: false,
      reason: "Not available for Minecraft 1.21.4",
      serverSide: "required",
      clientSide: "optional"
    },
    server_side: "required",
    client_side: "optional"
  }
];

export const initialDemoFiles: Record<string, string> = {
  "/server.properties": [
    "motd=ServerSentinel Demo",
    "max-players=20",
    "view-distance=10",
    "simulation-distance=8",
    "online-mode=true"
  ].join("\n"),
  "/config/serversentinel-demo.toml": [
    "demo = true",
    "runtime = \"simulated\"",
    "docker_required = false"
  ].join("\n"),
  "/logs/latest.log": [
    "[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.4",
    "[12:00:03] [Server thread/INFO]: Preparing spawn area: 100%",
    "[12:00:05] [Server thread/INFO]: Done (5.132s)! For help, type \"help\""
  ].join("\n")
};

export function demoServer(schedules: ScheduledExecution[] = initialDemoSchedules): ManagedServer {
  return {
    id: demoServerId,
    displayName: "Demo Survival",
    directoryLabel: "/demo/survival",
    storageName: "Browser demo",
    minecraftVersion: "1.21.4",
    loaderVersion: "0.16.10",
    installerVersion: "1.0.1",
    serverJar: "fabric-server-launch.jar",
    dockerContainer: "serversentinel-demo",
    dockerImage: "simulated-runtime",
    dockerPorts: "25565:25565/tcp",
    javaArgs: "-Xms2G -Xmx4G",
    schedules,
    serverType: "fabric",
    hasDockerContainer: true,
    resolvedVersions: {
      minecraftVersion: {
        version: "1.21.4",
        source: "demo",
        lastCheckedAt: new Date(demoStartedAt).toISOString()
      },
      fabricLoaderVersion: {
        version: "0.16.10",
        source: "demo",
        lastCheckedAt: new Date(demoStartedAt).toISOString()
      }
    }
  };
}

export function demoStatus(server: ManagedServer, running: boolean): ServerStatus {
  return {
    server,
    docker: {
      configured: true,
      available: true,
      controllable: true,
      state: running ? "running" : "exited",
      running,
      container: "serversentinel-demo",
      message: "Demo mode simulates runtime container control without Docker."
    },
    fileLogsAvailable: true,
    controlAvailable: true,
    commandInputAvailable: running,
    commandInputMessage: running ? "" : "Start the demo server to enable simulated console input."
  };
}

export function demoStats(running: boolean): ResourceSample {
  const elapsed = (Date.now() - demoStartedAt) / 1000;
  const memoryLimitBytes = 4 * 1024 * 1024 * 1024;
  const memoryUsageBytes = running ? Math.round((1.35 + Math.sin(elapsed / 12) * 0.18) * 1024 * 1024 * 1024) : 0;
  return {
    available: true,
    running,
    cpuPercent: running ? 8 + Math.max(0, Math.sin(elapsed / 7)) * 22 : 0,
    memoryUsageBytes,
    memoryLimitBytes,
    networkRxBytes: running ? Math.round(84_000_000 + elapsed * 680_000 + Math.sin(elapsed / 5) * 180_000) : 0,
    networkTxBytes: running ? Math.round(62_000_000 + elapsed * 510_000 + Math.cos(elapsed / 6) * 120_000) : 0,
    readAt: new Date().toISOString(),
    container: "serversentinel-demo",
    message: running ? "Simulated runtime stats." : "Demo server is stopped.",
    sampledAt: Date.now()
  };
}

export function demoOverviewData(running: boolean): ServerOverviewData {
  return {
    activity: {
      lastStartedAt: running ? new Date(demoStartedAt).toISOString() : new Date(demoStartedAt - 86_400_000).toISOString(),
      lastStoppedAt: running ? new Date(demoStartedAt - 86_400_000).toISOString() : new Date().toISOString(),
      lastRestartAt: new Date(demoStartedAt).toISOString(),
      currentWorld: "world",
      serverPort: "25565",
      eulaAccepted: true,
      javaRuntime: "Temurin 21",
      autosaveStatus: running ? "Recently saved" : "Unavailable",
      playersOnline: running ? 8 : 0,
      maxPlayers: 20
    },
    events: [
      { id: "demo-join-steve", type: "success", text: "Player joined: Steve", timestamp: "13:46:00", source: "logs/latest.log" },
      { id: "demo-join-alex", type: "success", text: "Player joined: Alex", timestamp: "13:43:00", source: "logs/latest.log" },
      { id: "demo-save", type: "success", text: "Server saved", timestamp: "13:20:00", source: "logs/latest.log" },
      { id: "demo-start", type: "success", text: "Server started", timestamp: "11:32:00", source: "logs/latest.log" },
      { id: "demo-warn", type: "warning", text: "Memory-related warning detected", timestamp: "11:12:00", source: "logs/latest.log" }
    ]
  };
}

export function demoListing(path: string, files: Record<string, string>, mods: InstalledMod[]): FileListing {
  if (path === "/mods") {
    return {
      path,
      entries: mods.map((mod) => ({
        name: mod.filename,
        path: `/mods/${mod.filename}`,
        type: "file",
        size: mod.size,
        modifiedAt: mod.modifiedAt
      }))
    };
  }
  if (path === "/config") {
    return {
      path,
      entries: [{
        name: "serversentinel-demo.toml",
        path: "/config/serversentinel-demo.toml",
        type: "file",
        size: files["/config/serversentinel-demo.toml"]?.length ?? 0,
        modifiedAt: new Date(demoStartedAt - 12_000_000).toISOString()
      }]
    };
  }
  if (path === "/logs") {
    return {
      path,
      entries: [{
        name: "latest.log",
        path: "/logs/latest.log",
        type: "file",
        size: files["/logs/latest.log"]?.length ?? 0,
        modifiedAt: new Date().toISOString()
      }]
    };
  }
  return {
    path: "/",
    entries: [
      { name: "config", path: "/config", type: "directory", size: 0, modifiedAt: new Date(demoStartedAt).toISOString() },
      { name: "logs", path: "/logs", type: "directory", size: 0, modifiedAt: new Date().toISOString() },
      { name: "mods", path: "/mods", type: "directory", size: 0, modifiedAt: new Date(demoStartedAt).toISOString() },
      {
        name: "server.properties",
        path: "/server.properties",
        type: "file",
        size: files["/server.properties"]?.length ?? 0,
        modifiedAt: new Date(demoStartedAt - 7_200_000).toISOString()
      }
    ]
  };
}
