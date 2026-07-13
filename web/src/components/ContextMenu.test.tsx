import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ContextMenuSurface, contextMenuPosition } from "./ContextMenu";

describe("ContextMenu", () => {
  it("keeps a menu at the requested point when it fits in the viewport", () => {
    expect(contextMenuPosition(
      { x: 120, y: 80 },
      { width: 200, height: 240 },
      { width: 1024, height: 768 }
    )).toEqual({ left: 120, top: 80 });
  });

  it("moves a menu left and up when it would cross the viewport edge", () => {
    expect(contextMenuPosition(
      { x: 980, y: 740 },
      { width: 220, height: 260 },
      { width: 1024, height: 768 }
    )).toEqual({ left: 796, top: 500 });
  });

  it("pins oversized menus to the viewport gutter", () => {
    expect(contextMenuPosition(
      { x: 100, y: 100 },
      { width: 900, height: 700 },
      { width: 640, height: 480 }
    )).toEqual({ left: 8, top: 8 });
  });

  it("renders labelled menu items, separators, and disabled critical states", () => {
    const html = renderToStaticMarkup(
      <ContextMenuSurface
        id="file-actions"
        label="File actions"
        left={24}
        top={32}
        onSelect={vi.fn()}
        items={[
          { id: "open", label: "Open", onSelect: vi.fn() },
          { id: "delete", label: "Delete", onSelect: vi.fn(), separatorBefore: true, critical: true, disabled: true }
        ]}
      />
    );

    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="File actions"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('role="menuitem"');
    expect(html).toContain("actionMenuItem--critical");
    expect(html).toContain("disabled");
  });
});
