import { FormEvent } from 'react';
import { Banner, Button, FormField } from './UiPrimitives';
import { BrandLogo } from './BrandLogo';
import { usernameInputPattern } from '../utils/inputPatterns';
import type { AuthField } from '../utils/authValidation';

export type AuthNotice = {
  tone: "error" | "warning";
  title: string;
  message: string;
};

export function AuthPanel({
  setupRequired,
  notice,
  onSubmit,
  busy = false,
  demoEnabled = false,
  fieldErrors = {},
  onFieldChange
}: {
  setupRequired: boolean;
  notice: AuthNotice | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  busy?: boolean;
  demoEnabled?: boolean;
  fieldErrors?: Partial<Record<AuthField, string>>;
  onFieldChange?: (field: AuthField) => void;
}) {
  return (
    <main className="authShell">
      {/* No `GlassEffect` here on purpose: `auth.css` hides the refractive inset
          and the shared rim on this panel, because at card size they read as a
          second nested surface. Mounting the layer anyway only pulled the
          liquid-glass chunk on the first screen of the app to render nothing. */}
      <section className={`authPanel uiGlassSurface uiGlassSurface--modal ${setupRequired ? "authPanel--setup" : ""}`.trim()}>
        <div className="brandLockup">
          <BrandLogo />
          <div>
            <h1>serverSENTINEL</h1>
          </div>
        </div>
        {setupRequired && (
          <div className="authSetupIntro">
            <span>Initial setup · Account</span>
            <h2>Create your administrator account</h2>
            <p>This account owns the first-run setup and receives full access to servers, nodes, integrations, and users.</p>
          </div>
        )}
        {notice && <Banner tone={notice.tone} role={notice.tone === "warning" ? "status" : undefined} title={notice.title} message={notice.message} />}
        {demoEnabled && (
          <Banner tone="info" data-testid="demo-credentials" title="Demo environment" message={<>Sign in with username <code>demo</code> and password <code>demo</code>. Do not create another user.</>} />
        )}
        {setupRequired && (
          <Banner
            tone="warning"
            title="One-time setup token required"
            message={<>Paste the token from the panel startup log. With Docker Compose, run <code>docker compose logs serversentinel</code>.</>}
          />
        )}
        <form
          onSubmit={onSubmit}
          className="appForm"
          autoComplete="on"
          method="post"
          action={setupRequired ? "/api/auth/register-first" : "/api/auth/login"}
          aria-busy={busy}
          noValidate
        >
          <fieldset>
            <legend className="srOnly">{setupRequired ? "Create the first administrator account" : "Sign in to serverSENTINEL"}</legend>
            {setupRequired && (
              <FormField className="authSetupTokenField" htmlFor="auth-setup-token" label="Setup token" error={fieldErrors.setupToken} required>
                <input
                  id="auth-setup-token"
                  name="setupToken"
                  type="password"
                  autoComplete="off"
                  required
                  minLength={16}
                  maxLength={256}
                  placeholder="Token from the panel log"
                  spellCheck={false}
                  aria-invalid={Boolean(fieldErrors.setupToken)}
                  onInput={() => onFieldChange?.("setupToken")}
                />
              </FormField>
            )}
            <FormField className="authUsernameField" htmlFor="auth-username" label="Username" error={fieldErrors.username} required>
              <input
                id="auth-username"
                name="username"
                type="text"
                autoComplete="username"
                required
                minLength={3}
                maxLength={32}
                pattern={usernameInputPattern}
                placeholder={setupRequired ? "admin" : "Username"}
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={Boolean(fieldErrors.username)}
                onInput={() => onFieldChange?.("username")}
              />
            </FormField>
              <FormField className="authPasswordField" htmlFor="auth-password" label="Password" error={fieldErrors.password} required>
              <input
                id="auth-password"
                name="password"
                type="password"
                autoComplete={setupRequired ? "new-password" : "current-password"}
                required
                minLength={setupRequired ? 8 : 1}
                maxLength={256}
                placeholder={setupRequired ? "At least 8 characters" : "Password"}
                aria-invalid={Boolean(fieldErrors.password)}
                onInput={() => onFieldChange?.("password")}
              />
            </FormField>
            {setupRequired && (
              <FormField className="authConfirmPasswordField" htmlFor="auth-confirm-password" label="Confirm password" error={fieldErrors.confirmPassword} required>
                <input
                  id="auth-confirm-password"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={256}
                  placeholder="Repeat password"
                  aria-invalid={Boolean(fieldErrors.confirmPassword)}
                  onInput={() => onFieldChange?.("confirmPassword")}
                />
              </FormField>
            )}
            <Button type="submit" disabled={busy} aria-busy={busy} reserveLabel={setupRequired ? "Create admin" : "Checking..."}>{busy ? "Checking..." : setupRequired ? "Create admin" : "Sign in"}</Button>
          </fieldset>
        </form>
      </section>
    </main>
  );
}
