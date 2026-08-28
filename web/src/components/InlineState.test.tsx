import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InlineState } from "./InlineState";

describe("InlineState", () => {
  it("routes warnings and errors through the shared banner framework", () => {
    const warning = renderToStaticMarkup(<InlineState tone="warning" title="Database unavailable" message="Configure the integration." />);
    const error = renderToStaticMarkup(<InlineState tone="error" title="Refresh failed" message="Try again." actionLabel="Retry" onAction={vi.fn()} />);

    expect(warning).toContain("uiBanner--warning");
    expect(warning).toContain("lucide-triangle-alert");
    expect(error).toContain("uiBanner--error");
    expect(error).toContain("lucide-circle-alert");
    expect(error).toContain("Retry");
  });

  it("keeps non-alert loading states lightweight", () => {
    const html = renderToStaticMarkup(<InlineState tone="loading" title="Loading" message="Reading data." />);

    expect(html).toContain("inlineState-loading");
    expect(html).toContain("uiSpinner");
    expect(html).not.toContain("uiBanner");
  });
});
