import { FormEvent } from 'react';
import { Banner, Button, FormField } from './UiPrimitives';
import { BrandLogo } from './BrandLogo';
import { usernameInputPattern } from '../utils/inputPatterns';

export function AuthPanel({
  setupRequired,
  notice,
  onSubmit,
  busy = false,
  demoEnabled = false
}: {
  setupRequired: boolean;
  notice: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  busy?: boolean;
  demoEnabled?: boolean;
}) {
  return (
    <main className="authShell">
      <section className="authPanel">
        <div className="brandLockup">
          <BrandLogo />
          <div>
            <h1>serverSENTINEL</h1>
            <p>{setupRequired ? "Create the first admin account" : "Sign in to manage servers"}</p>
          </div>
        </div>
        {notice && <Banner tone="info" title={notice} />}
        {demoEnabled && (
          <Banner tone="info" className="authSetupBanner" data-testid="demo-credentials" title="Demo environment." message={<>Sign in with username <code>demo</code> and password <code>demo</code>. Do not create another user.</>} />
        )}
        {setupRequired && (
          <Banner tone="warning" className="authSetupBanner" title="First-run setup." message="Enter the one-time setup token printed in the panel startup log, then create the admin account." />
        )}
        <form
          onSubmit={onSubmit}
          className="appForm"
          autoComplete="on"
          method="post"
          action={setupRequired ? "/api/auth/register-first" : "/api/auth/login"}
          aria-busy={busy}
        >
          <fieldset>
            {setupRequired && (
              <FormField htmlFor="auth-setup-token" label="Setup token" description="Use the one-time token printed in the panel startup log." required>
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
                />
              </FormField>
            )}
            <FormField htmlFor="auth-username" label="Username" required>
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
              />
            </FormField>
            <FormField htmlFor="auth-password" label="Password" required>
              <input
                id="auth-password"
                name="password"
                type="password"
                autoComplete={setupRequired ? "new-password" : "current-password"}
                required
                minLength={setupRequired ? 8 : 1}
                maxLength={256}
                placeholder={setupRequired ? "At least 8 characters" : "Password"}
              />
            </FormField>
            {setupRequired && (
              <FormField htmlFor="auth-confirm-password" label="Confirm password" required>
                <input
                  id="auth-confirm-password"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={256}
                  placeholder="Repeat password"
                />
              </FormField>
            )}
            <Button type="submit" disabled={busy} reserveLabel={setupRequired ? "Create admin" : "Checking..."}>{busy ? "Checking..." : setupRequired ? "Create admin" : "Sign in"}</Button>
          </fieldset>
        </form>
      </section>
    </main>
  );
}
