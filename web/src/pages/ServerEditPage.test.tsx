import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ManagedServer } from "../types";
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

function renderForm(disabled = false, disabledReason = "") {
  return renderToStaticMarkup(
    <ServerEditForm
      server={server}
      totalMemory={16 * 1024 * 1024 * 1024}
      onSubmit={vi.fn()}
      disabled={disabled}
      disabledReason={disabledReason}
      dangerZone={<section data-testid="danger-zone">Danger zone</section>}
    />
  );
}

describe("ServerEditForm", () => {
  it("renders a toolbar and distinct configuration cards with one advanced disclosure", () => {
    const html = renderForm();

    expect(html.match(/propertiesSettingsSurface/g)).toHaveLength(1);
    expect(html).toContain("propertiesToolbar");
    expect(html).toContain("propertiesSectionGeneral");
    expect(html).toContain("propertiesSectionResources");
    expect(html).toContain("propertiesSectionNetwork");
    expect(html).not.toContain("propertiesActionBar");
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).toContain(">General<");
    expect(html).toContain(">Resources<");
    expect(html).toContain(">Network<");
    expect(html).toContain(">Advanced<");
    expect(html).not.toContain(">Actions<");

    for (const name of [
      "displayName",
      "minecraftVersion",
      "runtimeType",
      "runtimeVersion",
      "javaArgs",
      "serverPort",
      "queryPort",
      "dockerImage",
      "serverJar",
      "dockerContainer",
      "dockerPorts",
      "startOnNodeStart"
    ]) {
      expect(html).toContain(`name="${name}"`);
    }

    expect(html).toContain("Discard changes");
    expect(html).toContain("Save changes");
    expect(html).toContain("Start when node starts");
    expect(html).toMatch(/name="startOnNodeStart"[^>]*checked=""/);
    expect(html).toContain('data-testid="danger-zone"');
  });

  it("keeps configuration inspectable while disabling mutations", () => {
    const reason = "Stop the server before changing mods or server properties.";
    const html = renderForm(true, reason);

    expect(html).toMatch(/class="[^"]*propertiesLockBanner[^"]*"/);
    expect(html).toContain(reason);
    expect(html).toMatch(/<fieldset disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Discard changes<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save changes<\/button>/);
    expect(html).toContain("-XX:+UseG1GC");
    expect(html).toContain("Additional port bindings");
    expect(html).not.toMatch(/<details[^>]*disabled/);
  });

  it("renders runtime-neutral version controls for a Paper profile without offering Fabric builds", () => {
    const paperServer: ManagedServer = {
      ...server,
      runtimeProfile: {
        ...server.runtimeProfile,
        runtimeType: "paper",
        runtimeVersion: "1.21.4-232",
        jarProvider: "papermc",
        jarArtifact: { filename: "paper.jar" }
      }
    };
    const html = renderToStaticMarkup(
      <ServerEditForm server={paperServer} totalMemory={16 * 1024 * 1024 * 1024} onSubmit={vi.fn()} />
    );

    expect(html).toContain("Paper build");
    expect(html).toContain("1.21.4-232");
    expect(html).not.toContain("Fabric Loader version");
    expect(html).not.toContain("0.16.10");
  });
});
