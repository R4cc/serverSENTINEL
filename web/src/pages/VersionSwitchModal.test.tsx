import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ManagedServer } from "../types";
import { VersionSwitchModal } from "./VersionSwitchModal";

const server = {
  id: "server-1",
  displayName: "Survival",
  nodeId: "local",
  runtimeProfile: {
    minecraftVersion: "1.21.1",
    runtimeType: "paper",
    runtimeVersion: "130",
    javaMajorVersion: 21,
    jarProvider: "papermc",
    jarArtifact: { filename: "paper.jar" },
    compatibilityStatus: "compatible",
    resolvedAt: "2026-01-01T00:00:00.000Z"
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
} as ManagedServer;

describe("VersionSwitchModal", () => {
  it("opens on the version choice with the runtime's own wording", () => {
    const html = renderToStaticMarkup(<VersionSwitchModal server={server} onClose={vi.fn()} onSwitched={vi.fn()} />);

    expect(html).toContain("Switch Minecraft version");
    expect(html).toContain("Survival · Paper");
    expect(html).toContain(">Minecraft version<");
    expect(html).toContain(">Paper build<");
    expect(html).toContain("Currently 1.21.1");
    expect(html).toContain("plugins without a matching version are disabled, never deleted");
    expect(html).toContain("Review changes");
    expect(html).toContain('role="dialog"');
  });
});
