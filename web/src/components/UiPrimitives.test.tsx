import { createRef, type ReactElement, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Banner, Button, FormField, HelpTooltip, MetricTile, PanelHeader, Surface, Toolbar } from "./UiPrimitives";

describe("UI primitives", () => {
  it("renders surfaces with semantic element, density, and tone contracts", () => {
    const html = renderToStaticMarkup(<Surface as="aside" density="compact" tone="subtle" material="glass">Details</Surface>);
    expect(html).toContain("<aside");
    expect(html).toContain("uiSurface--compact");
    expect(html).toContain("uiSurface--subtle");
    expect(html).toContain("uiSurface--glass");
    expect(html).toContain("uiGlassSurface");
  });

  it("supports opaque surfaces and forwards the semantic element ref", () => {
    const html = renderToStaticMarkup(<Surface>Data</Surface>);
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

  it("associates accessible help with its question-mark trigger", () => {
    const html = renderToStaticMarkup(<HelpTooltip id="retention-help" label="retained output">Higher values use more memory.</HelpTooltip>);

    expect(html).toContain('aria-label="About retained output"');
    expect(html).toContain('aria-describedby="retention-help"');
    expect(html).toContain('aria-controls="retention-help"');
    expect(html).toContain('id="retention-help" role="tooltip"');
  });

  it("supports a descriptive custom tooltip trigger", () => {
    const html = renderToStaticMarkup(<HelpTooltip id="events-help" label="2 related events" trigger={<span>2 related events</span>}>Event details</HelpTooltip>);

    expect(html).toContain('aria-label="About 2 related events"');
    expect(html).toContain('<span>2 related events</span>');
    expect(html).toContain('id="events-help" role="tooltip"');
  });

  it("hosts help in panel headers and form labels without nesting a button inside a label", () => {
    const panel = renderToStaticMarkup(<PanelHeader title="Players" help={<HelpTooltip id="players-help" label="players">Approximate locations.</HelpTooltip>} />);
    const field = renderToStaticMarkup(<FormField htmlFor="address" label="Address" help={<HelpTooltip id="address-help" label="address">Public host name.</HelpTooltip>}><input id="address" /></FormField>);

    expect(panel).toContain("uiPanelHeaderTitle");
    expect(panel).toContain('aria-describedby="players-help"');
    expect(field).toContain("uiFormFieldLabelRow");
    expect(field).toContain('for="address"');
    expect(field).toContain('aria-describedby="address-help"');
    expect(field).not.toMatch(/<label[^>]*>(?:(?!<\/label>)[\s\S])*<button/);
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

  it("gives warning and error banners unified icons and live-region semantics", () => {
    const error = renderToStaticMarkup(<Banner tone="error" title="Could not connect" />);
    const warning = renderToStaticMarkup(<Banner tone="warning" title="Restart required" />);

    expect(error).toContain('role="alert"');
    expect(error).toContain("lucide-circle-alert");
    expect(warning).toContain('role="status"');
    expect(warning).not.toContain('role="alert"');
    expect(warning).toContain("lucide-triangle-alert");
    expect(warning).toContain("uiBannerIcon");
  });

  it("supports compact alerts, rich details, and remediation actions", () => {
    const html = renderToStaticMarkup(
      <Banner tone="warning" compact title="Update required" message="Install the matching panel version." action={<Button>Open settings</Button>}>
        <code>26.9.1</code>
      </Banner>
    );

    expect(html).toContain("uiBanner--compact");
    expect(html).toContain("uiBannerDetails");
    expect(html).toContain("uiBannerAction");
    expect(html).toContain("Open settings");
  });

  it("renders metric tiles with semantic tones and optional detail", () => {
    const html = renderToStaticMarkup(<MetricTile tone="success" label="Status" value="Running" detail="Online" />);
    expect(html).toContain("uiMetricTile--success");
    expect(html).toContain("uiMetricTileDetail");
  });
});
