import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ManagedServer } from "../../types";
import { ExportModal } from "./ExportModal";
import type { ExportWorkspace } from "./useExportWorkspace";

const server: ManagedServer = {
  id: "server-1",
  displayName: "Survival",
  nodeId: "local",
  directoryLabel: "/servers/survival",
  dockerContainer: "survival",
  dockerImage: "eclipse-temurin:21-jre",
  dockerPorts: "25565:25565/tcp",
  javaArgs: "-Xms2G -Xmx4G",
  startOnNodeStart: true,
  hasDockerContainer: true,
  runtimeProfile: {
    minecraftVersion: "1.21.4",
    runtimeType: "fabric",
    runtimeVersion: "0.16.10",
    javaMajorVersion: 21,
    jarProvider: "mcjars",
    jarArtifact: { filename: "fabric-server-launch.jar" },
    compatibilityStatus: "compatible",
    resolvedAt: "2026-01-01T00:00:00.000Z"
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("ExportModal", () => {
  it("uses adaptive units and exposes exact bytes for every displayed size", () => {
    const worldBytes = Math.round(7.4846 * 1024 * 1024 * 1024);
    const availableBytes = 2.25 * 1024 * 1024 * 1024 * 1024;
    const workspace = {
      categories: ["world"],
      contentStrategy: "lockfile",
      estimate: {
        servers: [{
          serverId: server.id,
          displayName: server.displayName,
          running: false,
          categories: [{ category: "world", bytes: worldBytes, fileCount: 42 }],
          totalBytes: worldBytes
        }],
        totalBytes: worldBytes,
        availableBytes
      },
      estimating: false,
      exportBusy: false,
      exportError: "",
      closeExport: vi.fn(),
      toggleCategory: vi.fn(),
      setContentStrategy: vi.fn(),
      runExport: vi.fn()
    } as unknown as ExportWorkspace;

    const html = renderToStaticMarkup(<ExportModal workspace={workspace} server={server} />);

    expect(html).toContain("7.48 GiB");
    expect(html).toContain("2.25 TiB");
    expect(html.match(new RegExp(`title="${worldBytes.toLocaleString()} bytes"`, "g"))).toHaveLength(2);
    expect(html).toContain(`title="${availableBytes.toLocaleString()} bytes"`);
  });
});
