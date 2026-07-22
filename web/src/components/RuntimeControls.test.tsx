import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ServerStatus } from "../types";
import { RuntimeControls } from "./RuntimeControls";

function status(running: boolean): ServerStatus {
  return {
    controlAvailable: true,
    docker: {
      available: true,
      configured: true,
      running,
      state: running ? "running" : "exited"
    }
  } as ServerStatus;
}

describe("RuntimeControls", () => {
  it("exposes stable action hooks without changing accessible labels", () => {
    const html = renderToStaticMarkup(
      <RuntimeControls
        status={status(false)}
        isProvisioning={false}
        busyAction={null}
        onAction={vi.fn()}
      />
    );

    expect(html).toContain('aria-label="Container controls"');
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('data-action="start"');
    expect(html).toContain('controlGlyph-start');
    expect(html).toContain('aria-label="Start"');
    expect(html).toContain('data-action="restart"');
    expect(html).toContain('controlGlyph-restart');
    expect(html).toContain('aria-label="Restart unavailable: Start the server before restarting it."');
  });

  it("marks only the active runtime action as busy", () => {
    const html = renderToStaticMarkup(
      <RuntimeControls
        status={status(true)}
        isProvisioning={false}
        busyAction="restart"
        onAction={vi.fn()}
      />
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-busy-action="restart"');
    expect(html).toMatch(/data-action="restart"[^>]*data-busy="true"/);
    expect(html).toContain('aria-label="Stop unavailable: Runtime restart is already in progress."');
  });
});
