import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AddNodeModal, validateAddNodeInput } from "./NodesPage";

const validInput = {
  name: "Games host",
  panelUrl: "https://panel.example.com",
  dataMount: "/var/lib/serversentinel"
};

function renderAddNodeModal(browserPanelUrl: string) {
  return renderToStaticMarkup(
    <AddNodeModal
      busy={false}
      browserPanelUrl={browserPanelUrl}
      created={null}
      installMethod="run"
      onInstallMethodChange={vi.fn()}
      onClose={vi.fn()}
      onDone={vi.fn()}
      onCreate={vi.fn()}
      onCopy={vi.fn()}
      formatDate={(value) => String(value)}
    />
  );
}

describe("new node panel address", () => {
  it("accepts panel addresses that a different host can use", () => {
    expect(validateAddNodeInput(validInput)).toBe("");
    expect(validateAddNodeInput({ ...validInput, panelUrl: "http://192.168.1.50:8080" })).toBe("");
  });

  it.each([
    "http://localhost:8080",
    "http://node.localhost:8080",
    "http://127.0.0.1:8080",
    "http://0.0.0.0:8080",
    "http://[::1]:8080"
  ])("rejects the local-only address %s", (panelUrl) => {
    expect(validateAddNodeInput({ ...validInput, panelUrl })).toMatch(/node itself|another computer/);
  });

  it("starts empty and explains why a browser localhost address is not copied", () => {
    const html = renderAddNodeModal("http://localhost:8080");

    expect(html).toContain("How the node connects");
    expect(html).toContain("This is the panel&#x27;s address, not the new node&#x27;s address.");
    expect(html).toContain("local-only address");
    expect(html).not.toContain("Use this address");
    expect(html).toContain('name="panelUrl" value=""');
    expect(html).toContain("Create install command");
  });

  it("offers a non-loopback browser address as an explicit choice instead of a default", () => {
    const html = renderAddNodeModal("https://panel.example.com");

    expect(html).toContain("Use this address");
    expect(html).toContain('name="panelUrl" value=""');
  });
});
