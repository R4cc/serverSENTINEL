import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ContextNode } from "../../types";
import { ImportModal } from "./ImportModal";
import type { ExportWorkspace } from "./useExportWorkspace";

describe("ImportModal", () => {
  it("clearly allows an import that will be quarantined for duplicate ports", () => {
    const workspace = {
      importValidation: {
        valid: true,
        issues: [],
        warnings: [{
          code: "conflicting_port",
          serverName: "Creative",
          message: 'Port 25565/tcp is already assigned to "Survival". The imported server will stay stopped until you choose a different port.'
        }],
        plan: {
          targetNodeId: "local",
          categories: ["world"],
          servers: [{
            sourceId: "source",
            newId: "new",
            displayName: "Creative",
            storageName: "new",
            serverDir: "/servers/new",
            fileCount: 1,
            totalBytes: 1024,
            lockfileCount: 0,
            portConflicts: []
          }]
        }
      },
      importBusy: false,
      importTargetNodeId: "local",
      importFile: null,
      importTask: "",
      importProgress: 0,
      importError: "",
      closeImport: vi.fn(),
      setImportFile: vi.fn(),
      setImportTargetNodeId: vi.fn(),
      uploadAndValidate: vi.fn(),
      runImport: vi.fn()
    } as unknown as ExportWorkspace;
    const nodes: ContextNode[] = [{
      id: "local",
      name: "Local",
      type: "local",
      status: "online",
      isInternal: true,
      servers: []
    }];

    const html = renderToStaticMarkup(<ImportModal workspace={workspace} nodes={nodes} onImported={vi.fn()} />);

    expect(html).toContain("Imported servers will need a port change");
    expect(html).toContain("cannot start until you change the port in Properties");
    expect(html).toContain("Import with unresolved issue");
    expect(html).not.toContain("This archive cannot be imported yet");
  });
});
