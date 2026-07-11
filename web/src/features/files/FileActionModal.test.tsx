import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../../types";
import { FileActionModal } from "./FilesPage";

const noop = vi.fn();
const file: FileEntry = { name: "server.properties", path: "/server.properties", type: "file", size: 42, modifiedAt: "2026-01-01T00:00:00.000Z" };
const folder: FileEntry = { name: "world", path: "/world", type: "directory", size: 0, modifiedAt: "2026-01-01T00:00:00.000Z" };

function render(dialog: Parameters<typeof FileActionModal>[0]["dialog"]) {
  return renderToStaticMarkup(<FileActionModal dialog={dialog} busy={false} onValueChange={noop} onCancel={noop} onSubmit={noop} />);
}

describe("FileActionModal", () => {
  it("renders an accessible named create form with inline validation", () => {
    const html = render({ kind: "create", value: "bad/name", error: "The name contains unsafe characters." });
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Create a new folder");
    expect(html).toContain("Folder name");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
  });

  it("summarizes destructive scope and warns about recursive deletion", () => {
    const html = render({ kind: "delete", entries: [file, folder], error: "" });
    expect(html).toContain("Delete 2 items?");
    expect(html).toContain("<strong>1</strong> file");
    expect(html).toContain("<strong>1</strong> folder");
    expect(html).toContain("everything inside them will be deleted");
    expect(html).toContain("cannot be undone");
  });
});
