import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InstalledModsList } from "./InstalledModsList";
import { ModDetailsPanel } from "./ModDetailsPanel";
import { managedContentTerminology } from "./contentTerminology";
import type { InstalledMod } from "../../types";

const plugin: InstalledMod = {
  filename: "essentialsx.jar",
  displayName: "EssentialsX",
  enabled: true,
  size: 1024,
  modifiedAt: "2026-07-18T12:00:00.000Z",
  preferredChannel: "release",
  modrinth: {
    projectId: "essentialsx",
    versionId: "v1",
    filename: "essentialsx.jar",
    versionNumber: "2.21.0",
    gameVersions: ["1.21.4"],
    loaders: ["paper"],
    installedAt: "2026-07-18T12:00:00.000Z",
    installedWithForceIncompatible: false
  }
};

describe("Paper managed-content terminology", () => {
  const terminology = managedContentTerminology("paper");

  it("describes the Paper plugin directory and Modrinth project type", () => {
    expect(terminology).toMatchObject({ runtimeName: "Paper", singular: "plugin", plural: "plugins", directory: "plugins", modrinthProjectType: "plugin" });
  });

  it("renders the installed workspace without presenting plugins as Fabric mods", () => {
    const html = renderToStaticMarkup(<InstalledModsList terminology={terminology} mods={[plugin]} query="" busy={false} locked={false} onQueryChange={() => undefined} onToggle={() => undefined} onUpdate={() => undefined} onSwitchVersion={() => undefined} onDetails={() => undefined} />);

    expect(html).toContain("Installed plugins");
    expect(html).toContain(">Plugin<");
    expect(html).not.toContain("Installed mods");
    expect(html).not.toContain("Fabric mod");
  });

  it("links Paper plugin details to the Modrinth plugin project", () => {
    const html = renderToStaticMarkup(<ModDetailsPanel terminology={terminology} mod={plugin} locked={false} reviewAcknowledgementLocked={false} formatDate={(value) => String(value)} onClose={() => undefined} onToggle={() => undefined} onUpdate={() => undefined} onRemove={() => undefined} onAcknowledgeReview={() => undefined} />);

    expect(html).toContain("https://modrinth.com/plugin/essentialsx");
    expect(html).toContain('aria-label="Close plugin details"');
  });
});
