import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModrinthKeyForm } from "./SettingsPanels";

describe("ModrinthKeyForm", () => {
  it("renders a stable pending surface before integration state is known", () => {
    const html = renderToStaticMarkup(<ModrinthKeyForm onSubmit={vi.fn()} configured={false} loading />);

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("keyFormConfigured keyFormPending");
    expect(html).toContain("Loading Modrinth integration status");
  });

  it("renders configured state directly without a post-render synchronization state", () => {
    const html = renderToStaticMarkup(<ModrinthKeyForm onSubmit={vi.fn()} configured />);

    expect(html).toContain("Configured");
    expect(html).toContain("Replace key");
    expect(html).not.toContain("Paste API key");
  });
});
