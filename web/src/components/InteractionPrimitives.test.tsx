import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActionMenu } from "./ActionMenu";
import { DialogSurface } from "./DialogSurface";

describe("interaction primitives", () => {
  it("renders an explicitly controlled, collapsed action menu trigger", () => {
    const html = renderToStaticMarkup(
      <ActionMenu
        label="More file actions"
        trigger={<span>More</span>}
        items={[{ id: "delete", label: "Delete", critical: true, onSelect: vi.fn() }]}
      />
    );

    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="More file actions"');
    expect(html).not.toContain('role="menu"');
  });

  it("renders a focusable, labelled modal surface", () => {
    const html = renderToStaticMarkup(
      <DialogSurface className="modalPanel" labelledBy="dialog-title" onClose={vi.fn()}>
        <h2 id="dialog-title">Example dialog</h2>
      </DialogSurface>
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="dialog-title"');
    expect(html).toContain('tabindex="-1"');
  });
});
