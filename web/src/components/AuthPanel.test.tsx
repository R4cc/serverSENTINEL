import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuthPanel, type AuthNotice } from "./AuthPanel";

function renderAuthPanel(overrides: Partial<Parameters<typeof AuthPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <AuthPanel
      setupRequired={false}
      notice={null}
      onSubmit={vi.fn()}
      {...overrides}
    />
  );
}

describe("AuthPanel", () => {
  it("keeps the default sign-in page focused on the brand and form", () => {
    const html = renderAuthPanel();

    expect(html).toContain("serverSENTINEL");
    expect(html).toContain('action="/api/auth/login"');
    expect(html).toContain('noValidate=""');
    expect(html).toContain(">Sign in<");
    expect(html).not.toContain("Sign in to manage servers");
    expect(html).not.toContain("Create the first admin account");
  });

  it("shows the demo guidance as an informational banner", () => {
    const html = renderAuthPanel({ demoEnabled: true });

    expect(html).toContain('data-testid="demo-credentials"');
    expect(html).toContain("uiBanner--info");
    expect(html).toContain("Demo environment");
    expect(html).toContain("Do not create another user.");
  });

  it("shows first-run guidance once with warning semantics", () => {
    const html = renderAuthPanel({ setupRequired: true });

    expect(html).toContain("uiBanner--warning");
    expect(html).toContain("First-run setup");
    expect(html).toContain('action="/api/auth/register-first"');
    expect(html.match(/one-time setup token printed in the panel startup log/g)).toHaveLength(1);
    expect(html).toContain(">Create admin<");
  });

  it.each([
    [{ tone: "error", title: "Sign-in failed", message: "Invalid username or password" }, "uiBanner--error", 'role="alert"'],
    [{ tone: "warning", title: "Session ended", message: "Sign in again to continue" }, "uiBanner--warning", 'role="status"']
  ] satisfies Array<[AuthNotice, string, string]>)("renders %s notices with the matching semantics", (notice, toneClass, role) => {
    const html = renderAuthPanel({ notice });

    expect(html).toContain(toneClass);
    expect(html).toContain(role);
    expect(html).toContain(notice.title);
    expect(html).toContain(notice.message);
  });

  it("names the credential group for assistive technology without showing a second heading", () => {
    expect(renderAuthPanel()).toContain('<legend class="srOnly">Sign in to serverSENTINEL</legend>');
    expect(renderAuthPanel({ setupRequired: true })).toContain('<legend class="srOnly">Create the first administrator account</legend>');
  });

  it("uses one stable busy state for either authentication flow", () => {
    const html = renderAuthPanel({ busy: true });

    // The form and the control it submits both report the same in-flight state,
    // so the button is not merely dimmed with no explanation.
    expect(html.match(/aria-busy="true"/g)).toHaveLength(2);
    expect(html).toContain("disabled");
    expect(html).toContain("Checking...");
  });

  it("renders every field validation message beside its owning control", () => {
    const fieldErrors = {
      setupToken: "Setup token is required.",
      username: "Username must be 3-32 characters.",
      password: "Password must be at least 8 characters.",
      confirmPassword: "Passwords do not match."
    };
    const html = renderAuthPanel({ setupRequired: true, fieldErrors });

    for (const message of Object.values(fieldErrors)) expect(html).toContain(message);
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(4);
    expect(html.match(/role="alert"/g)).toHaveLength(4);
  });
});
