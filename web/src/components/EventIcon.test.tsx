import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScheduleEventIcon } from "./EventIcon";

describe("schedule event icon", () => {
  it("renders a centered calendar glyph", () => {
    const html = renderToStaticMarkup(createElement(ScheduleEventIcon));

    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('<rect x="4" y="5" width="16" height="15" rx="2"></rect>');
    expect(html).toContain('d="M8 3v4M16 3v4M4 10h16"');
  });
});
