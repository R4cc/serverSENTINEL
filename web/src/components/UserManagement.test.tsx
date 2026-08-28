import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PublicUser } from "../types";
import { UserManagement } from "./UserManagement";

const users: PublicUser[] = [
  { id: "2", username: "Zulu", rolePreset: "operator", permissions: ["servers.view"], createdAt: "2026-01-02T00:00:00.000Z" },
  { id: "1", username: "Alpha", rolePreset: "viewer", permissions: ["servers.view"], createdAt: "2026-01-01T00:00:00.000Z" }
];

describe("UserManagement table", () => {
  it("uses shared sortable headers and one overflow action menu per row", () => {
    const html = renderToStaticMarkup(
      <UserManagement
        users={users}
        currentUserId="1"
        editingUser={null}
        onOpenEdit={vi.fn()}
        onCloseModal={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onResetPassword={vi.fn(async () => true)}
        onDelete={vi.fn()}
      />
    );

    expect(html).toContain('aria-label="Users"');
    expect(html).toContain('<th scope="col" aria-sort="ascending"><button type="button" class="uiSortHeaderButton"');
    expect(html).toContain('aria-label="Actions for Alpha"');
    expect(html).toContain('aria-label="Actions for Zulu"');
    expect(html.indexOf("Alpha")).toBeLessThan(html.indexOf("Zulu"));
    expect(html).not.toContain(">Reset password</button>");
  });
});
