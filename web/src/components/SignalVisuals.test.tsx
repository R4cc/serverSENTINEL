import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignalFingerprint, SignalIllustration, SignalMeter, signalFingerprintGeometry } from "./SignalVisuals";

describe("signal visuals", () => {
  it("derives stable server fingerprints without storing presentation data", () => {
    expect(signalFingerprintGeometry("server-a")).toEqual(signalFingerprintGeometry("server-a"));
    expect(signalFingerprintGeometry("server-a")).not.toEqual(signalFingerprintGeometry("server-b"));
  });

  it("keeps illustrations decorative", () => {
    const html = renderToStaticMarkup(<SignalIllustration kind="files" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("signalIllustrationGlyph");
  });

  it.each(["servers", "players", "files", "mods", "schedules", "events", "search"] as const)("renders the %s empty-state variant", (kind) => {
    const html = renderToStaticMarkup(<SignalIllustration kind={kind} compact />);
    expect(html).toContain("signalIllustration--compact");
    expect(html).toContain('aria-hidden="true"');
  });

  it("clamps decorative meters to their supported range", () => {
    expect(renderToStaticMarkup(<SignalMeter value={160} />)).toContain("--signal-meter-value:100");
    expect(renderToStaticMarkup(<SignalMeter value={-12} />)).toContain("--signal-meter-value:0");
  });

  it("renders the server fingerprint as a reusable decorative mark", () => {
    const html = renderToStaticMarkup(<SignalFingerprint serverId="server-a" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("signalFingerprintNode");
  });
});
