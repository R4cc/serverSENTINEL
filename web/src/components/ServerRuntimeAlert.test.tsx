import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServerRuntimeAlert } from "./ServerRuntimeAlert";
import { Button } from "./UiPrimitives";

describe("ServerRuntimeAlert", () => {
  it("renders a prominent accessible runtime failure notice", () => {
    const html = renderToStaticMarkup(
      <ServerRuntimeAlert
        title="Node offline"
        message="Runtime actions and file access are unavailable until the node reconnects."
      />
    );

    expect(html).toContain('class="serverRuntimeAlert"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Node offline");
    expect(html).toContain("Runtime actions and file access are unavailable until the node reconnects.");
    expect(html).toContain('aria-hidden="true"');
  });

  it("renders a compact title-only notice for the server action row", () => {
    const html = renderToStaticMarkup(<ServerRuntimeAlert title="Node offline" compact />);

    expect(html).toContain('class="serverRuntimeAlert compact"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Node offline");
    expect(html).not.toContain("serverRuntimeAlertCopy\"><strong>Node offline</strong><span>");
  });

  it("can offer a direct remediation action", () => {
    const html = renderToStaticMarkup(
      <ServerRuntimeAlert title="Unresolved port conflict" action={<Button>Open Properties</Button>} />
    );
    expect(html).toContain("Open Properties");
  });
});
