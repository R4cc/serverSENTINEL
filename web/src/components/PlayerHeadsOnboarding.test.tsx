import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PlayerHeadsOnboarding } from "./PlayerHeadsOnboarding";

describe("PlayerHeadsOnboarding", () => {
  it("requires an explicit privacy choice and identifies the provider", () => {
    const html = renderToStaticMarkup(<PlayerHeadsOnboarding busy={false} error="" onChoose={vi.fn()} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Player heads on Overview");
    expect(html).toContain("MCHeads (mc-heads.net)");
    expect(html).toContain("When disabled, no MCHeads requests are made");
    expect(html).toContain("refresh on a rolling daily schedule");
    expect(html).not.toContain("12 hours");
    expect(html).toContain(">Keep disabled</button>");
    expect(html).toContain("Enable player heads");
    expect(html).not.toContain("modalCloseButton");
  });

  it("keeps persistence errors visible", () => {
    const html = renderToStaticMarkup(<PlayerHeadsOnboarding busy={false} error="Database unavailable" onChoose={vi.fn()} />);
    expect(html).toContain("Could not save this choice");
    expect(html).toContain("Database unavailable");
  });
});
