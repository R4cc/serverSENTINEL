import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConfirmationModal, type ConfirmationOptions } from "./ConfirmationModal";

function render(options: ConfirmationOptions) {
  return renderToStaticMarkup(
    <ConfirmationModal options={options} onConfirm={vi.fn()} onCancel={vi.fn()} />
  );
}

describe("ConfirmationModal", () => {
  it("renders an accessible destructive confirmation with details and a warning", () => {
    const html = render({
      title: "Delete Example?",
      description: "Delete this user account.",
      details: "example-user",
      warning: "This action cannot be undone.",
      confirmLabel: "Delete user",
      variant: "critical"
    });

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain("Delete Example?");
    expect(html).toContain("example-user");
    expect(html).toContain("This action cannot be undone.");
    expect(html).toContain("confirmationWarning--danger");
    expect(html).toContain("uiButton--critical");
    expect(html).toContain("Delete user");
  });

  it("supports primary actions and custom cancellation labels", () => {
    const html = render({
      title: "Restart node?",
      description: "Restart the node container.",
      warning: "The node will disconnect briefly.",
      confirmLabel: "Restart node",
      cancelLabel: "Keep running",
      variant: "primary"
    });

    expect(html).toContain("uiButton--primary");
    expect(html).toContain("Restart node");
    expect(html).toContain("Keep running");
    expect(html).toContain("confirmationWarning--warning");
  });
});
