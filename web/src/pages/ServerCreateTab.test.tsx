import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ServerCreateTab } from "./ServerCreateTab";

describe("ServerCreateTab", () => {
  it("uses recovery guidance that applies to infrastructure failures", () => {
    const html = renderToStaticMarkup(
      <ServerCreateTab
        provisionOperation={undefined}
        provisioningError="Docker is not reachable on the selected node."
        provisioningErrorDetails="connect ENOTSOCK C:\\private\\docker.fake"
        onClearProvisioningError={vi.fn()}
        nodes={[]}
        preferredNodeId=""
        provisioning={false}
        disabledReason=""
        onRefreshNodes={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(html).toContain("resolve the reported problem");
    expect(html).not.toContain("adjust the form");
    expect(html).toContain("Show full API failure log");
  });
});
