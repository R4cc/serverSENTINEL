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
    for (const id of describedBy?.split(" ") ?? []) expect(html).toContain(`id="${id}"`);
    expect(describedBy?.split(" ")).toHaveLength(2);
    expect(html).toContain("Delete Example?");
    expect(html).toContain("example-user");
    expect(html).toContain("This action cannot be undone.");
    expect(html).toContain("uiBanner--error");
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
    expect(html).toContain("uiBanner--warning");
  });

  it("renders a required text area for confirmations that capture a reason", () => {
    const html = render({
      title: "Restart Survival?",
      description: "Survival will be temporarily unavailable while it restarts.",
      textInput: {
        label: "Reason for restarting",
        description: "Saved with the server operation for traceability.",
        placeholder: "Why is this server being restarted?",
        required: true,
        maxLength: 500,
        rows: 3
      },
      confirmLabel: "Restart server",
      variant: "primary"
    });

    expect(html).toContain("Reason for restarting");
    expect(html).toContain("Saved with the server operation for traceability.");
    expect(html).toMatch(/<textarea[^>]*required=""[^>]*maxLength="500"[^>]*rows="3"/);
    expect(html).toContain('placeholder="Why is this server being restarted?"');
  });
});
