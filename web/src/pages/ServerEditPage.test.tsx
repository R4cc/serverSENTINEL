import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FabricVersions, ManagedServer } from "../types";
import { ServerEditForm } from "./ServerEditPage";

const server: ManagedServer = {
  id: "server-1",
  displayName: "Survival",
  nodeId: "local",
  directoryLabel: "/servers/survival",
  dockerContainer: "survival",
  dockerImage: "eclipse-temurin:21-jre",
  dockerPorts: "25565:25565/tcp,25566:25566/udp,8123:8123/tcp",
  javaArgs: "-Xms2G -Xmx4G -XX:+UseG1GC",
  hasDockerContainer: true,
  runtimeProfile: {
    minecraftVersion: "1.21.4",
    loader: "fabric",
    loaderVersion: "0.16.10",
    javaMajorVersion: 21,
    jarProvider: "mcjars",
    jarArtifact: { filename: "fabric-server-launch.jar" },
    compatibilityStatus: "compatible",
    resolvedAt: "2026-01-01T00:00:00.000Z"
  }
};

const versions: FabricVersions = {
  game: [{ version: "1.21.4", stable: true, type: "release" }],
  loader: [{ version: "0.16.10", stable: true }],
  installer: []
};

function renderForm(disabled = false, disabledReason = "") {
  return renderToStaticMarkup(
    <ServerEditForm
      server={server}
      versions={versions}
      totalMemory={16 * 1024 * 1024 * 1024}
      onSubmit={vi.fn()}
      disabled={disabled}
      disabledReason={disabledReason}
      dangerZone={<section data-testid="danger-zone">Danger zone</section>}
    />
  );
}

describe("ServerEditForm", () => {
  it("renders one settings surface with a single advanced disclosure and preserved fields", () => {
    const html = renderForm();

    expect(html.match(/propertiesSettingsSurface/g)).toHaveLength(1);
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).toContain(">General<");
    expect(html).toContain(">Resources<");
    expect(html).toContain(">Network<");
    expect(html).toContain(">Advanced<");
    expect(html).not.toContain(">Actions<");

    for (const name of [
      "displayName",
      "minecraftVersion",
      "loaderVersion",
      "javaArgs",
      "serverPort",
      "queryPort",
      "dockerImage",
      "serverJar",
      "dockerContainer",
      "dockerPorts"
    ]) {
      expect(html).toContain(`name="${name}"`);
    }

    expect(html).toContain("Discard changes");
    expect(html).toContain("Save changes");
    expect(html).toContain('data-testid="danger-zone"');
  });

  it("keeps configuration inspectable while disabling mutations", () => {
    const reason = "Stop the server before changing mods or server properties.";
    const html = renderForm(true, reason);

    expect(html).toContain('class="propertiesLockBanner"');
    expect(html).toContain(reason);
    expect(html).toMatch(/<fieldset disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Discard changes<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save changes<\/button>/);
    expect(html).toContain("-XX:+UseG1GC");
    expect(html).toContain("Additional port bindings");
    expect(html).not.toMatch(/<details[^>]*disabled/);
  });
});
