import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RestartRequiredBadge } from "./RestartRequiredBadge";

describe("RestartRequiredBadge", () => {
  it("renders the restart label and pending mod actions", () => {
    const html = renderToStaticMarkup(<RestartRequiredBadge changes={[
      { type: "mod", identity: "modrinth:example", displayName: "Example Mod", filename: "example.jar", action: "added" },
      { type: "mod", identity: "file:removed.jar", displayName: "Removed Mod", filename: "removed.jar", action: "removed" }
    ]} />);
    expect(html).toContain("Restart required");
    expect(html).toContain("Added:");
    expect(html).toContain("Example Mod");
    expect(html).toContain("Removed:");
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("aria-describedby");
  });

  it("renders a generic explanation for legacy restart state", () => {
    const html = renderToStaticMarkup(<RestartRequiredBadge />);
    expect(html).toContain("Mods have changed");
    expect(html).not.toContain("<ul>");
  });

  it("uses plugin terminology for Paper servers", () => {
    const html = renderToStaticMarkup(<RestartRequiredBadge runtimeType="paper" />);
    expect(html).toContain("Plugins have changed");
    expect(html).not.toContain("Mods have changed");
  });
});
