import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoServer, demoStatus } from "../demo";
import type { PlayerSnapshot } from "../types";
import { ActiveServerStrip } from "./ActiveServerStrip";

const server = demoServer();

function render(playerSnapshot: PlayerSnapshot | undefined) {
  return renderToStaticMarkup(
    createElement(ActiveServerStrip, {
      server,
      runtimeAction: null,
      runtimeFeedbackAction: null,
      serverCommandTone: "ready",
      lastKnownRuntimeLabel: "Running",
      health: null,
      healthDetail: "",
      alert: null,
      nodeName: "Local node",
      runtimeDisplayName: "Fabric",
      runtimeVersion: "0.16.9",
      minecraftVersion: "1.21.1",
      playerSnapshot,
      nodeOffline: false,
      status: demoStatus(server, true),
      controlAvailableFallback: true,
      controlsDisabled: false,
      controlsDisabledReason: "",
      onRuntimeAction: () => {},
      consoleActive: false,
      onOpenConsole: () => {},
      onRetryConnection: () => {},
      refreshDisabled: false,
      refreshDisabledReason: ""
    })
  );
}

describe("ActiveServerStrip player count", () => {
  it("shows online out of max when both are known", () => {
    const markup = render({ state: "live", online: 3, maxPlayers: 20, names: ["a", "b", "c"], sampledAt: "2026-07-25T10:00:00.000Z" });
    expect(markup).toContain("3 / 20");
  });

  it("shows only the online count when the maximum is unknown", () => {
    const markup = render({ state: "live", online: 3, maxPlayers: null, names: ["a", "b", "c"], sampledAt: "2026-07-25T10:00:00.000Z" });
    expect(markup).toContain("serverStripPlayers");
    expect(markup).not.toContain("3 / 20");
    expect(markup).toContain("</svg>3</small>");
  });

  it("keeps a stopped server at zero", () => {
    expect(render({ state: "stopped", online: 0, maxPlayers: 20, names: [], sampledAt: "2026-07-25T10:00:00.000Z" })).toContain("0 / 20");
  });

  it("omits the item when the count is unavailable or missing", () => {
    const unavailable = render({ state: "unavailable", online: null, maxPlayers: 20, names: [], code: "QUERY_DISABLED", message: "Query disabled" });
    expect(unavailable).not.toContain("serverStripPlayers");
    expect(render(undefined)).not.toContain("serverStripPlayers");
  });
});
