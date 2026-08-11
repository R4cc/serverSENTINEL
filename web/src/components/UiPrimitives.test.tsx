import { createRef, type ReactElement, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Banner, Button, FormField, MetricTile, PanelHeader, Surface, Toolbar } from "./UiPrimitives";

describe("UI primitives", () => {
  it("renders surfaces with semantic element, density, and tone contracts", () => {
    const html = renderToStaticMarkup(<Surface as="aside" density="compact" tone="subtle">Details</Surface>);
    expect(html).toContain("<aside");
    expect(html).toContain("uiSurface--compact");
    expect(html).toContain("uiSurface--subtle");
    expect(html).toContain("uiSurface--glass");
    expect(html).toContain("uiGlassSurface");
  });

  it("supports opaque surfaces and forwards the semantic element ref", () => {
    const html = renderToStaticMarkup(<Surface material="solid">Data</Surface>);
    expect(html).toContain("uiSurface--solid");
    expect(html).not.toContain("uiGlassSurface");

    const ref = createRef<HTMLElement>();
    const renderSurface = (Surface as unknown as {
      render: (props: { as: "aside"; children: string }, ref: Ref<HTMLElement>) => ReactElement<{ ref?: Ref<HTMLElement> }>;
    }).render;
    const element = renderSurface({ as: "aside", children: "Details" }, ref);
    expect(element.type).toBe("aside");
    expect(element.props.ref).toBe(ref);
  });

  it("renders compact panel headers at the requested heading level", () => {
    const html = renderToStaticMarkup(<PanelHeader title="Installed mods" description="Five total" headingLevel={3} compact />);
    expect(html).toContain("uiPanelHeader--compact");
    expect(html).toContain("<h3>Installed mods</h3>");
  });

  it("groups toolbar content without changing action semantics", () => {
    const html = renderToStaticMarkup(<Toolbar primary={<Button>Add</Button>} meta="Just now" secondary={<Button variant="secondary">Refresh</Button>} />);
    expect(html).toContain("uiToolbarPrimary");
    expect(html).toContain("uiToolbarMeta");
    expect(html).toContain("uiToolbarSecondary");
  });

  it("connects form labels and exposes validation errors", () => {
    const html = renderToStaticMarkup(<FormField htmlFor="name" label="Display name" required error="Display name is required"><input id="name" /></FormField>);
    expect(html).toContain('for="name"');
    expect(html).toContain("uiFormField--error");
    expect(html).toContain('role="alert"');
  });

  it("uses alert semantics only for error banners", () => {
    expect(renderToStaticMarkup(<Banner tone="error" title="Could not connect" />)).toContain('role="alert"');
    expect(renderToStaticMarkup(<Banner tone="warning" title="Restart required" />)).not.toContain('role="alert"');
  });

  it("renders metric tiles with semantic tones and optional detail", () => {
    const html = renderToStaticMarkup(<MetricTile tone="success" label="Status" value="Running" detail="Online" />);
    expect(html).toContain("uiMetricTile--success");
    expect(html).toContain("uiMetricTileDetail");
  });
});
