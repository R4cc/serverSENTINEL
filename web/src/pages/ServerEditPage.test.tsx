import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ManagedServer } from "../types";
import type { ServerExportState } from "../features/exports/useExportWorkspace";
import { DeleteServerPanel, ExportServerPanel, ServerEditForm } from "./ServerEditPage";

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

function renderForm(disabled = false, disabledReason = "", saving = false) {
  return renderToStaticMarkup(
    <ServerEditForm
      server={server}
      totalMemory={16 * 1024 * 1024 * 1024}
      onSubmit={vi.fn()}
      disabled={disabled}
      disabledReason={disabledReason}
      saving={saving}
      exportPanel={<ExportServerPanel server={server} onExport={vi.fn()} />}
      dangerZone={<section data-testid="danger-zone">Danger zone</section>}
    />
  );
}

describe("ServerEditForm", () => {
  it("renders distinct configuration cards with one advanced disclosure and no idle actions", () => {
    const html = renderForm();

    expect(html.match(/propertiesSettingsSurface/g)).toHaveLength(1);
    expect(html).not.toContain("propertiesToolbar");
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

    expect(html).not.toContain("propertiesSaveDock");
    expect(html).not.toContain("Discard");
    expect(html).not.toContain("Save changes");
    expect(html).toContain("Start when node starts");
    expect(html).toMatch(/name="startOnNodeStart"[^>]*checked=""/);
    expect(html).toContain('data-testid="danger-zone"');
  });

  it("offers the per-server export outside the settings form so its button cannot submit it", () => {
    const html = renderForm();
    const formEnd = html.indexOf("</form>");

    expect(html).toContain("propertiesExportZone");
    expect(html).toContain("propertiesSideCards--paired");
    expect(html).toContain("Export server");
    expect(html).toContain(`Download ${server.displayName} as a ZIP archive`);
    expect(formEnd).toBeGreaterThan(-1);
    expect(html.indexOf("propertiesExportZone")).toBeGreaterThan(formEnd);
  });

  it("links network and advanced help text to the controls it describes", () => {
    const html = renderForm();

    expect(html).toMatch(/id="properties-server-port"[^>]*aria-describedby="properties-server-port-hint"/);
    expect(html).toMatch(/id="properties-query-port"[^>]*aria-describedby="properties-query-port-hint"/);
    expect(html).toMatch(/id="edit-docker-image"[^>]*aria-describedby="edit-docker-image-description"/);
    expect(html).toMatch(/id="edit-server-jar"[^>]*aria-describedby="edit-server-jar-description"/);
    expect(html).toMatch(/id="edit-docker-container"[^>]*aria-describedby="edit-docker-container-description"/);
    expect(html).toMatch(/id="edit-java-args"[^>]*aria-describedby="edit-java-args-description"/);
  });

  it("presents high memory allocation as advice rather than a validation error", () => {
    const html = renderToStaticMarkup(
      <ServerEditForm server={server} totalMemory={4 * 1024 * 1024 * 1024} onSubmit={vi.fn()} />
    );

    expect(html).toContain("propertiesMemoryWarning");
    expect(html).toContain("Leave some RAM for the host");
    expect(html).not.toMatch(/class="fieldError"[^>]*>Leave some RAM for the host/);
  });

  it("keeps configuration inspectable while disabling mutations", () => {
    const reason = "Stop the server before changing mods or server properties.";
    const html = renderForm(true, reason);

    expect(html).toMatch(/class="[^"]*propertiesLockBanner[^"]*"/);
    expect(html).toContain(reason);
    expect(html).toMatch(/<fieldset disabled=""/);
    expect(html).not.toContain("propertiesSaveDock");
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

describe("ExportServerPanel", () => {
  const task = (overrides: Partial<NonNullable<ServerExportState["latest"]>> = {}): ServerExportState["latest"] => ({
    id: "export-2",
    status: "running",
    progress: 37,
    task: "Compressing world files",
    createdAt: "2026-01-02T00:00:00.000Z",
    canCancel: true,
    ...overrides
  });

  it("moves saving feedback into the animated save button without a warning banner", () => {
    const html = renderForm(true, "Server settings are saving.", true);

    expect(html).not.toContain("propertiesLockBanner");
    expect(html).not.toContain("Server settings are saving.");
    expect(html).toContain("propertiesSaveDock");
    expect(html).toContain("Saving changes");
    expect(html).toContain("uiSpinner");
    expect(html).toContain('aria-busy="true"');
  });

  it("renders the empty, succeeded, and cancelled states", () => {
    const empty = renderToStaticMarkup(<ExportServerPanel server={server} onExport={vi.fn()} />);
    const succeeded = renderToStaticMarkup(
      <ExportServerPanel server={server} onExport={vi.fn()} state={{ latest: task({ status: "succeeded", progress: 100, task: "Export ready" }), artifact: null }} />
    );
    const cancelled = renderToStaticMarkup(
      <ExportServerPanel server={server} onExport={vi.fn()} state={{ latest: task({ status: "cancelled", task: "Export cancelled by user", errorMessage: "Export cancelled by user" }), artifact: null }} />
    );

    expect(empty).toContain("No export has been created yet.");
    expect(empty).toContain("No exports");
    expect(succeeded).toContain("Ready");
    expect(succeeded).toContain("Export ready");
    expect(cancelled).toContain("Cancelled");
    expect(cancelled).toContain("Export cancelled by user");
  });

  it("shows exact progress and the owner abort control while running", () => {
    const html = renderToStaticMarkup(
      <ExportServerPanel
        server={server}
        onExport={vi.fn()}
        onCancel={vi.fn()}
        state={{ latest: task(), artifact: null }}
        formatDate={() => "Jan 2"}
      />
    );

    expect(html).toContain("Compressing world files");
    expect(html).toContain("37%");
    expect(html).toMatch(/<progress[^>]*value="37"/);
    expect(html).toContain(" Abort</button>");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*New export/s);
  });

  it("shows cancelling without allowing another abort", () => {
    const html = renderToStaticMarkup(
      <ExportServerPanel server={server} onExport={vi.fn()} state={{ latest: task({ task: "Cancelling export" }), artifact: null }} />
    );

    expect(html).toContain("Cancelling");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Cancelling/s);
  });

  it("shows owner finalization without offering abort or misidentifying the user", () => {
    const html = renderToStaticMarkup(
      <ExportServerPanel
        server={server}
        onExport={vi.fn()}
        state={{ latest: task({ task: "Finalizing export", progress: 99, canCancel: false, startedByRequester: true }), artifact: null }}
      />
    );

    expect(html).toContain("Finalizing export");
    expect(html).toContain("99%");
    expect(html).not.toContain(" Abort</button>");
    expect(html).not.toContain("started by another user");
  });

  it("keeps the previous private download visible after a failed replacement", () => {
    const artifactBytes = Math.round(7.4846 * 1024 * 1024 * 1024);
    const html = renderToStaticMarkup(
      <ExportServerPanel
        server={server}
        onExport={vi.fn()}
        onDelete={vi.fn()}
        state={{
          latest: task({ status: "failed", progress: 88, task: "Export failed", errorMessage: "A very long remote stream error", finishedAt: "2026-01-03T00:00:00.000Z" }),
          artifact: {
            operationId: "export-1",
            filename: "survival.zip",
            size: artifactBytes,
            createdAt: "2026-01-01T00:00:00.000Z",
            downloadUrl: "/api/exports/export-1/download"
          }
        }}
        formatDate={() => "Jan 3"}
      />
    );

    expect(html).toContain("Failed");
    expect(html).toContain("A very long remote stream error");
    expect(html).toContain("Last successful export");
    expect(html).toContain("7.48 GiB");
    expect(html).toContain(`title="${artifactBytes.toLocaleString()} bytes"`);
    expect(html).toContain('href="/api/exports/export-1/download"');
    expect(html).toContain("exportArtifactCopy");
    expect(html).toContain("exportArtifactActions");
    expect(html).toContain(" Delete</span>");
  });

  it("keeps the delete action stable while the archive is being removed", () => {
    const html = renderToStaticMarkup(
      <ExportServerPanel
        server={server}
        onExport={vi.fn()}
        onDelete={vi.fn()}
        deletingExportId="export-1"
        state={{
          latest: task({ id: "export-1", status: "succeeded", progress: 100, task: "Export ready" }),
          artifact: {
            operationId: "export-1",
            filename: "survival.zip",
            createdAt: "2026-01-01T00:00:00.000Z",
            downloadUrl: "/api/exports/export-1/download"
          }
        }}
      />
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Deleting…/s);
  });

  it("shares another user's progress but keeps its controls and download private", () => {
    const html = renderToStaticMarkup(
      <ExportServerPanel
        server={server}
        onExport={vi.fn()}
        state={{
          latest: task({ canCancel: false }),
          artifact: { operationId: "export-1", filename: "survival.zip", createdAt: "2026-01-01T00:00:00.000Z" }
        }}
      />
    );

    expect(html).toContain("This export was started by another user.");
    expect(html).toContain("Download available to the user who created it.");
    expect(html).not.toContain(" Abort</button>");
    expect(html).not.toContain('href="/api/exports/export-1/download"');
  });
});

describe("DeleteServerPanel", () => {
  it("makes the exact-name confirmation requirement explicit", () => {
    const html = renderToStaticMarkup(<DeleteServerPanel server={server} onSubmit={vi.fn()} />);

    expect(html).toContain('aria-describedby="delete-server-confirm-hint"');
    expect(html).toContain("Enter “Survival” exactly to enable deletion.");
    expect(html).toContain('autoComplete="off"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Enter “Survival” exactly to enable deletion"/);
  });
});
