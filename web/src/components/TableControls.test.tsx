import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TablePagination, TableSortButton } from "./TableControls";

describe("shared table controls", () => {
  it("renders a framework-neutral sort control without claiming header semantics", () => {
    const html = renderToStaticMarkup(
      <TableSortButton sorted="asc" onClick={() => undefined} label="Name">Name</TableSortButton>
    );

    expect(html).toContain('class="uiSortHeaderButton"');
    expect(html).toContain("Sort by Name");
    expect(html).toContain("↑");
    expect(html).not.toContain('role="columnheader"');
    expect(html).not.toContain("aria-sort");
  });

  it("uses the same range and accessible pager contract on every paginated table", () => {
    const html = renderToStaticMarkup(
      <TablePagination pageIndex={1} pageSize={10} totalItems={23} itemLabel="events" onPageChange={() => undefined} />
    );

    expect(html).toContain("Showing 11–20 of 23 events");
    expect(html).toContain('aria-label="events pagination"');
    expect(html).toContain("Page 2 of 3");
  });
});
