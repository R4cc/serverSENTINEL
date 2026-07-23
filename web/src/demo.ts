import type { FileListing, InstalledMod, ManagedServer, ModrinthHit, PlayerSnapshot, ResourceSample, ScheduledExecution, ServerEvent, ServerOverviewData, ServerStatus, ServerTimelineEvent, ServerTimelineResponse, ServerTimelineScheduleMarker } from "./types";

const demoStartedAt = Date.now();
const gibibyte = 1024 * 1024 * 1024;

export type DemoSession = {
  startedAt: number;
  playerCount: number;
  maxPlayers: number;
  onlinePlayerNames: string[];
  offlinePlayerNames: string[];
  cpuBasePercent: number;
  cpuAmplitudePercent: number;
  cpuPhase: number;
  memoryBaseBytes: number;
  memoryAmplitudeBytes: number;
  memoryPhase: number;
  networkRxBytesPerSecond: number;
  networkTxBytesPerSecond: number;
  events: ServerTimelineEvent[];
};

function randomUnit(random: () => number) {
  return Math.min(0.999999999, Math.max(0, random()));
}

function randomInteger(minimum: number, maximum: number, random: () => number) {
  return minimum + Math.floor(randomUnit(random) * (maximum - minimum + 1));
}

function randomDecimal(minimum: number, maximum: number, random: () => number) {
  return minimum + randomUnit(random) * (maximum - minimum);
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInteger(0, index, random);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function createDemoNicknames(count: number, random: () => number) {
  const prefixes = ["Aero", "Ash", "Blaze", "Cinder", "Frost", "Lunar", "Pixel", "Quartz", "Shadow", "Void"];
  const suffixes = ["Badger", "Byte", "Crafter", "Drake", "Fox", "Nomad", "Raven", "Spark", "Strider", "Wolf"];
  return shuffled(prefixes.flatMap((prefix) => suffixes.map((suffix) => `${prefix}${suffix}`)), random).slice(0, count);
}

function createDemoTimelineEvent(
  eventType: ServerEvent["eventType"],
  occurredAt: number,
  index: number,
  onlinePlayerNames: string[],
  offlinePlayerNames: string[],
  random: () => number
): ServerTimelineEvent {
  const timestamp = new Date(occurredAt).toISOString();
  const base = {
    id: `demo-event-${index}-${eventType}`,
    eventType,
    timestamp,
    occurredAt,
    source: "logs/latest.log" as const
  };
  if (eventType === "player_joined" || eventType === "player_left") {
    const candidates = eventType === "player_joined" ? onlinePlayerNames : offlinePlayerNames;
    const subject = candidates[randomInteger(0, candidates.length - 1, random)];
    const action = eventType === "player_joined" ? "joined" : "left";
    return {
      ...base,
      type: eventType === "player_joined" ? "success" : "info",
      severity: eventType === "player_joined" ? "success" : "info",
      text: `${subject} ${action}`,
      message: `${subject} ${action}`,
      signature: `${eventType}:${subject.toLowerCase()}`,
      subject
    };
  }
  if (eventType === "server_started") {
    return { ...base, type: "success", severity: "success", text: "Server started", message: "Server started", signature: "server_started" };
  }
  if (eventType === "server_stopped") {
    return { ...base, type: "info", severity: "info", text: "Server stopped", message: "Server stopped", signature: "server_stopped" };
  }
  if (eventType === "server_crashed") {
    return { ...base, type: "error", severity: "error", text: "Server process crashed", message: "Server process crashed", details: "Process exited unexpectedly and was recovered by the restart policy", signature: "server_crashed" };
  }
  if (eventType === "exception_caught") {
    const exception = shuffled(["ChunkLoadException", "TickTimeoutException", "WorldSaveException"], random)[0];
    return { ...base, type: "error", severity: "error", text: `Exception caught: ${exception}`, message: `Exception caught: ${exception}`, details: `A simulated ${exception} was caught by the demo server`, signature: `exception_caught:${exception.toLowerCase()}`, subject: exception };
  }
  if (eventType === "mod_disabled") {
    const mod = shuffled(["spark.jar", "lithium.jar", "voicechat.jar"], random)[0];
    return { ...base, type: "warning", severity: "warning", text: `Mod disabled: ${mod}`, message: `Mod disabled: ${mod}`, signature: `mod_disabled:${mod}`, subject: mod };
  }
  const ticksBehind = randomInteger(42, 164, random);
  return {
    ...base,
    type: "warning",
    severity: "warning",
    text: "Server is falling behind",
    message: "Server is falling behind",
    details: `Running ${Math.round(ticksBehind * 50).toLocaleString("en-US")}ms or ${ticksBehind} ticks behind`,
    signature: "server_overloaded"
  };
}

export function createDemoSession(random: () => number = Math.random, startedAt = Date.now()): DemoSession {
  const playerCount = randomInteger(10, 40, random);
  const nicknames = createDemoNicknames(playerCount + 8, random);
  const onlinePlayerNames = nicknames.slice(0, playerCount);
  const offlinePlayerNames = nicknames.slice(playerCount);
  const systemEventTypes: ServerEvent["eventType"][] = [
    "server_stopped",
    "server_crashed",
    "exception_caught",
    "mod_disabled",
    "server_overloaded"
  ];
  const eventTypes = shuffled<ServerEvent["eventType"]>([
    "server_started",
    "player_joined",
    "player_left",
    ...shuffled(systemEventTypes, random).slice(0, 4)
  ], random);
  const minuteOffsets = [3, 8, 14, 21, 29, 38, 49];
  const events = eventTypes.map((eventType, index) => createDemoTimelineEvent(
    eventType,
    startedAt - (minuteOffsets[index] + randomDecimal(-1.25, 1.25, random)) * 60_000,
    index,
    onlinePlayerNames,
    offlinePlayerNames,
    random
  )).sort((left, right) => left.occurredAt - right.occurredAt);

  return {
    startedAt,
    playerCount,
    maxPlayers: 50,
    onlinePlayerNames,
    offlinePlayerNames,
    cpuBasePercent: randomDecimal(18, 42, random),
    cpuAmplitudePercent: randomDecimal(8, 22, random),
    cpuPhase: randomDecimal(0, Math.PI * 2, random),
    memoryBaseBytes: randomDecimal(1.6, 2.8, random) * gibibyte,
    memoryAmplitudeBytes: randomDecimal(0.15, 0.55, random) * gibibyte,
    memoryPhase: randomDecimal(0, Math.PI * 2, random),
    networkRxBytesPerSecond: randomInteger(420_000, 920_000, random),
    networkTxBytesPerSecond: randomInteger(280_000, 740_000, random),
    events
  };
}

let activeDemoSession = createDemoSession(Math.random, demoStartedAt);

export function resetDemoSession(startedAt = Date.now()) {
  activeDemoSession = createDemoSession(Math.random, startedAt);
  return activeDemoSession;
}

export const demoServerId = "demo-survival";

export const initialDemoSchedules: ScheduledExecution[] = [{
  id: "demo-schedule-backup",
  name: "Nightly backup",
  cron: "0 4 * * *",
  steps: [
    { type: "command", command: "say Restarting for nightly maintenance", delaySeconds: 0 },
    { type: "action", procedure: "restart", delaySeconds: 300 }
  ],
  onlyWhenNoPlayers: true,
  enabled: true,
  createdAt: new Date(demoStartedAt - 86_400_000).toISOString(),
  updatedAt: new Date(demoStartedAt - 3_600_000).toISOString(),
  lastRunAt: new Date(demoStartedAt - 18_000_000).toISOString(),
  lastStatus: "succeeded",
  lastMessage: "Demo execution completed",
  nextRunAt: new Date(demoStartedAt + 10_800_000).toISOString(),
  recentRuns: [{
    id: "demo-run-nightly-backup",
    scheduleId: "demo-schedule-backup",
    scheduleName: "Nightly backup",
    status: "succeeded",
    message: "Demo execution completed",
    ranAt: new Date(demoStartedAt - 18_000_000).toISOString(),
    details: {
      stepCount: 2,
      completedStepCount: 2,
      terminalStepIndex: 1,
      terminalStep: "Restart",
      steps: [{
        stepIndex: 0,
        type: "command",
        command: "say Restarting for nightly maintenance",
        delaySeconds: 0,
        status: "success",
        startedAt: new Date(demoStartedAt - 18_000_000).toISOString(),
        completedAt: new Date(demoStartedAt - 17_999_500).toISOString(),
        logs: [
          "[Server thread/INFO]: [Server] Restarting for nightly maintenance",
          "[Server thread/INFO]: Saved the game"
        ],
        logCaptureStatus: "captured"
      }, {
        stepIndex: 1,
        type: "action",
        procedure: "restart",
        delaySeconds: 300,
        status: "success",
        startedAt: new Date(demoStartedAt - 17_700_000).toISOString(),
        completedAt: new Date(demoStartedAt - 17_690_000).toISOString()
      }]
    }
  }]
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
    project_id: "sodium",
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
    "motd=serverSENTINEL Demo",
    `max-players=${activeDemoSession.maxPlayers}`,
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
    nodeId: "local",
    nodeName: "Internal Node",
    directoryLabel: "/demo/survival",
    storageName: "Browser demo",
    runtimeProfile: {
      minecraftVersion: "1.21.4",
      runtimeType: "fabric",
      runtimeVersion: "0.16.10",
      loader: "fabric",
      loaderVersion: "0.16.10",
      javaMajorVersion: 21,
      jarProvider: "mcjars",
      jarArtifact: {
        filename: "fabric-server-launch.jar",
        downloadUrl: "https://example.invalid/fabric-server-launch.jar"
      },
      compatibilityStatus: "compatible",
      resolvedAt: new Date(demoStartedAt).toISOString()
    },
    dockerContainer: "serversentinel-demo",
    dockerImage: "simulated-runtime",
    dockerPorts: "25565:25565/tcp",
    javaArgs: "-Xms2G -Xmx4G",
    restartRequiredSince: new Date(demoStartedAt - 1_800_000).toISOString(),
    restartRequiredChanges: [{
      type: "mod",
      identity: "sodium",
      displayName: "Sodium",
      filename: "sodium-fabric-0.5.8+mc26.1.2.jar",
      action: "updated"
    }],
    schedules,
    hasDockerContainer: true,
    resolvedVersions: {
      minecraftVersion: {
        version: "1.21.4",
        source: "demo",
        lastCheckedAt: new Date(demoStartedAt).toISOString()
      },
      runtimeVersion: {
        version: "0.16.10",
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
    commandInputMessage: running ? "" : "Start the demo server to enable simulated console input.",
    lifecycle: {
      intent: running ? "running" : "stopped",
      state: running ? "running" : "stopped"
    }
  };
}

export function demoStats(running: boolean, sampledAt = Date.now()): ResourceSample {
  const elapsed = (sampledAt - activeDemoSession.startedAt) / 1000;
  const historyElapsed = Math.max(0, (sampledAt - (activeDemoSession.startedAt - 60 * 60 * 1000)) / 1000);
  const memoryLimitBytes = 4 * gibibyte;
  const cpuCapacityCores = 4;
  const cpuWave = Math.sin(elapsed / 23 + activeDemoSession.cpuPhase) * 0.65
    + Math.sin(elapsed / 7 + activeDemoSession.cpuPhase * 1.7) * 0.35;
  const cpuUtilizationPercent = running
    ? Math.min(85, Math.max(5, activeDemoSession.cpuBasePercent + activeDemoSession.cpuAmplitudePercent * cpuWave))
    : 0;
  const memoryWave = Math.sin(elapsed / 79 + activeDemoSession.memoryPhase) * 0.7
    + Math.sin(elapsed / 19 + activeDemoSession.memoryPhase * 1.3) * 0.3;
  const memoryUsageBytes = running
    ? Math.round(Math.min(3.6 * gibibyte, Math.max(1.1 * gibibyte, activeDemoSession.memoryBaseBytes + activeDemoSession.memoryAmplitudeBytes * memoryWave)))
    : 0;
  return {
    available: true,
    running,
    cpuPercent: cpuUtilizationPercent * cpuCapacityCores,
    cpuCapacityCores,
    memoryUsageBytes,
    memoryLimitBytes,
    playersOnline: running ? activeDemoSession.playerCount : 0,
    networkRxBytes: running ? Math.round(84_000_000 + historyElapsed * activeDemoSession.networkRxBytesPerSecond + Math.sin(elapsed / 5) * 180_000) : 0,
    networkTxBytes: running ? Math.round(62_000_000 + historyElapsed * activeDemoSession.networkTxBytesPerSecond + Math.cos(elapsed / 6) * 120_000) : 0,
    readAt: new Date(sampledAt).toISOString(),
    container: "serversentinel-demo",
    message: running ? "Simulated runtime stats." : "Demo server is stopped.",
    sampledAt
  };
}

export function demoStatsHistory(
  running: boolean,
  sampledAt = Date.now(),
  sampleIntervalMs = 5_000,
  sampleLimit = 721
): ResourceSample[] {
  return Array.from({ length: sampleLimit }, (_, index) => (
    demoStats(running, sampledAt - (sampleLimit - index - 1) * sampleIntervalMs)
  ));
}

export function demoTimelineData(running: boolean, schedules: ScheduledExecution[], from: number, to: number): ServerTimelineResponse {
  const step = Math.max(5_000, Math.ceil((to - from) / 900 / 5_000) * 5_000);
  const raw = Array.from({ length: Math.max(2, Math.floor((to - from) / step) + 1) }, (_, index) => demoStats(running, Math.min(to, from + index * step)));
  const samples = raw.map((sample, index) => {
    const previous = raw[index - 1];
    const elapsedSeconds = previous ? Math.max(1, (sample.sampledAt - previous.sampledAt) / 1000) : 0;
    const valid = sample.available && sample.running;
    return {
      sampledAt: sample.sampledAt,
      available: sample.available,
      running: sample.running,
      cpuPercent: valid ? sample.cpuPercent : null,
      cpuUtilizationPercent: valid && sample.cpuCapacityCores ? sample.cpuPercent / sample.cpuCapacityCores : null,
      memoryUsageBytes: valid ? sample.memoryUsageBytes : null,
      memoryLimitBytes: valid ? sample.memoryLimitBytes : null,
      memoryUtilizationPercent: valid && sample.memoryLimitBytes ? sample.memoryUsageBytes / sample.memoryLimitBytes * 100 : null,
      playersOnline: valid ? sample.playersOnline ?? null : null,
      networkRxBytesPerSecond: valid && previous && sample.networkRxBytes !== undefined && previous.networkRxBytes !== undefined
        ? Math.max(0, (sample.networkRxBytes - previous.networkRxBytes) / elapsedSeconds)
        : null,
      networkTxBytesPerSecond: valid && previous && sample.networkTxBytes !== undefined && previous.networkTxBytes !== undefined
        ? Math.max(0, (sample.networkTxBytes - previous.networkTxBytes) / elapsedSeconds)
        : null
    };
  });
  const now = Date.now();
  const eventFixtures = activeDemoSession.events.filter((event) => event.occurredAt >= from && event.occurredAt <= to);
  const demoOnlineNames = running ? activeDemoSession.onlinePlayerNames : [];
  const playerSessions = [
    ...demoOnlineNames.map((player, index) => ({
      id: `demo-online:${player.toLowerCase()}`,
      player,
      startedAt: now - (58 - index * 3) * 60_000,
      endedAt: null,
      startBoundary: index === 0 ? "history-boundary" as const : "join" as const,
      endBoundary: "online" as const
    })),
    ...activeDemoSession.offlinePlayerNames.map((player, index) => {
      const startedAt = now - (54 - index * 5) * 60_000;
      return {
        id: `demo-offline:${player.toLowerCase()}`,
        player,
        startedAt,
        endedAt: startedAt + (8 + index * 2) * 60_000,
        startBoundary: index === 0 ? "history-boundary" as const : "join" as const,
        endBoundary: "leave" as const
      };
    })
  ].filter((session) => session.startedAt <= to && (session.endedAt ?? now) >= from);
  const scheduleMarkers: ServerTimelineScheduleMarker[] = schedules.flatMap((schedule) => {
    const markers: ServerTimelineScheduleMarker[] = [];
    for (const run of schedule.recentRuns ?? []) {
      const occurredAt = new Date(run.ranAt).getTime();
      if (occurredAt >= from && occurredAt <= to) markers.push({ id: `run:${run.id}`, scheduleId: schedule.id, scheduleName: schedule.name, occurredAt, kind: "run", status: "success", runId: run.id, message: run.message });
    }
    const upcomingAt = schedule.nextRunAt ? new Date(schedule.nextRunAt).getTime() : NaN;
    if (Number.isFinite(upcomingAt) && upcomingAt >= from && upcomingAt <= to) markers.push({ id: `upcoming:${schedule.id}:${upcomingAt}`, scheduleId: schedule.id, scheduleName: schedule.name, occurredAt: upcomingAt, kind: "upcoming", status: "upcoming" });
    return markers;
  });
  if (schedules[0] && now + 3 * 60_000 >= from && now + 3 * 60_000 <= to) {
    scheduleMarkers.push({ id: "upcoming:demo-near", scheduleId: schedules[0].id, scheduleName: schedules[0].name, occurredAt: now + 3 * 60_000, kind: "upcoming", status: "upcoming" });
  }
  return {
    from,
    to,
    generatedAt: new Date(now).toISOString(),
    latest: samples.at(-1),
    samples,
    events: eventFixtures,
    schedules: scheduleMarkers.sort((left, right) => left.occurredAt - right.occurredAt),
    playerActivity: {
      snapshotState: running ? "live" : "stopped",
      sampledAt: new Date(now).toISOString(),
      onlineNames: demoOnlineNames,
      sessions: playerSessions
    },
    scheduleAnnotationsAvailable: true,
    truncated: { schedules: false }
  };
}

function demoEvent(event: ServerEvent): ServerEvent {
  return event;
}

export function demoOverviewData(running: boolean): ServerOverviewData {
  const events = activeDemoSession.events
    .slice()
    .sort((left, right) => right.occurredAt - left.occurredAt)
    .map(({ occurredAt: _occurredAt, ...event }) => event);
  return {
    eventsStatus: "ok",
    activity: {
      lastStartedAt: running ? new Date(demoStartedAt).toISOString() : new Date(demoStartedAt - 86_400_000).toISOString(),
      lastStoppedAt: running ? new Date(demoStartedAt - 86_400_000).toISOString() : new Date().toISOString(),
      lastRestartAt: new Date(demoStartedAt).toISOString(),
      currentWorld: "world",
      serverPort: "25565",
      eulaAccepted: true,
      javaRuntime: "Temurin 21",
      autosaveStatus: running ? "Recently saved" : "Unavailable"
    },
    events: events.map(demoEvent)
  };
}

export function demoPlayerSnapshot(running: boolean): PlayerSnapshot {
  return running ? {
    state: "live",
    online: activeDemoSession.playerCount,
    maxPlayers: activeDemoSession.maxPlayers,
    names: activeDemoSession.onlinePlayerNames,
    sampledAt: new Date().toISOString()
  } : {
    state: "stopped",
    online: 0,
    maxPlayers: activeDemoSession.maxPlayers,
    names: [],
    sampledAt: new Date().toISOString()
  };
}

export function demoListing(path: string, files: Record<string, string>, mods: InstalledMod[]): FileListing {
  const normalizedPath = path === "/" ? "/" : `/${path.split("/").filter(Boolean).join("/")}`;
  const entries = new Map<string, FileListing["entries"][number]>();
  const addDirectory = (directoryPath: string, modifiedAt = new Date(demoStartedAt).toISOString()) => {
    if (directoryPath === normalizedPath || directoryPath === "/") return;
    entries.set(directoryPath, {
      name: directoryPath.split("/").filter(Boolean).at(-1) ?? directoryPath,
      path: directoryPath,
      type: "directory",
      size: 0,
      modifiedAt,
      status: "ok"
    });
  };
  const addFile = (filePath: string, content: string, modifiedAt = new Date(demoStartedAt - 7_200_000).toISOString()) => {
    if (filePath.endsWith("/.serversentinel-folder")) return;
    entries.set(filePath, {
      name: filePath.split("/").filter(Boolean).at(-1) ?? filePath,
      path: filePath,
      type: "file",
      size: new Blob([content]).size,
      modifiedAt,
      permissions: "0644",
      status: "ok"
    });
  };

  for (const [filePath, content] of Object.entries(files)) {
    const parts = filePath.split("/").filter(Boolean);
    const parentPath = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : "/";
    if (parentPath === normalizedPath) {
      addFile(filePath, content);
      continue;
    }
    if (normalizedPath === "/" && parts.length > 1) {
      addDirectory(`/${parts[0]}`);
      continue;
    }
    if (parentPath.startsWith(`${normalizedPath === "/" ? "" : normalizedPath}/`)) {
      const relative = parentPath.slice(normalizedPath === "/" ? 1 : normalizedPath.length + 1).split("/")[0];
      if (relative) addDirectory(`${normalizedPath === "/" ? "" : normalizedPath}/${relative}`);
    }
  }

  if (normalizedPath === "/") {
    addDirectory("/config");
    addDirectory("/logs", new Date().toISOString());
    addDirectory("/mods");
  }
  if (normalizedPath === "/mods") {
    for (const mod of mods) {
      entries.set(`/mods/${mod.filename}`, {
        name: mod.filename,
        path: `/mods/${mod.filename}`,
        type: "file",
        size: mod.size,
        modifiedAt: mod.modifiedAt,
        permissions: "0644",
        status: "binary"
      });
    }
  }

  return {
    path: normalizedPath,
    entries: [...entries.values()].sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name))
  };
}
