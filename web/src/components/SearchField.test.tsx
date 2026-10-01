import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SearchField } from "./SearchField";

describe("shared search field", () => {
  it("keeps the accessible name separate from contextual placeholder text", () => {
    const html = renderToStaticMarkup(<SearchField label="Search Modrinth for mods" placeholder="Search by mod name…" value="" onChange={() => undefined} />);
    const id = /<input[^>]*id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
    expect(html).toContain("Search Modrinth for mods</label>");
    expect(html).toContain('placeholder="Search by mod name…"');
    expect(html).not.toContain("Clear search");
  });

  it("locks both search and clear when editing is disabled", () => {
    const html = renderToStaticMarkup(<SearchField label="Search mods" value="fabric" disabled onChange={() => undefined} />);
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Clear search mods"/);
  });
});
