import { FormEvent, ReactNode, useId, useState } from 'react';
import { Button, FormField, LoadingLabel, SkeletonBlock, StatusBadge } from './UiPrimitives';

export function IntegrationControlField({ label, children, ariaHidden = false }: { label: string; children: ReactNode; ariaHidden?: boolean }) {
  return (
    <FormField className="settingsHubIntegrationField" label={label} aria-hidden={ariaHidden || undefined}>{children}</FormField>
  );
}

/**
 * The MaxMind account that lets the panel download the GeoLite2 City database.
 *
 * Shaped like the Modrinth key form because it is the same kind of setting, with one difference
 * worth spelling out on screen: this credential is used to fetch a database, never to look anything
 * up. Every player lookup runs against the local file, so no player address is sent to MaxMind
 * or to any other geolocation service.
 */
export function MaxmindCredentialsForm({
  onSubmit,
  configured,
  disabled = false,
  loading = false
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  configured: boolean;
  disabled?: boolean;
  loading?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const fieldId = useId();

  function submitCredentials(event: FormEvent<HTMLFormElement>) {
    onSubmit(event);
    setEditing(false);
  }

  if (loading) {
    return (
      <div className="keyForm keyFormConfigured keyFormPending" aria-busy="true">
        <LoadingLabel>Loading GeoLite2 integration status</LoadingLabel>
        <IntegrationControlField label="MaxMind credentials" ariaHidden>
          <div className="secretPreview">
            <SkeletonBlock className="integrationKeySkeleton" />
            <SkeletonBlock className="uiSkeleton--badge" />
          </div>
        </IntegrationControlField>
        <div className="keyFormActions" aria-hidden="true">
          <SkeletonBlock className="integrationActionSkeleton" />
        </div>
      </div>
    );
  }

  if (configured && !editing) {
    return (
      <div className="keyForm keyFormConfigured">
        <IntegrationControlField label="MaxMind credentials">
          <div className="secretPreview" aria-label="Stored MaxMind credentials">
            <code aria-hidden="true">**** **** **** ****</code>
            <StatusBadge tone="success">Configured</StatusBadge>
          </div>
        </IntegrationControlField>
        <div className="keyFormActions">
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={disabled} title={disabled ? "Manage integrations permission is required" : "Replace MaxMind credentials"}>Replace credentials</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submitCredentials} className="keyForm keyForm--credentials">
      <fieldset disabled={disabled} title={disabled ? "Manage integrations permission is required" : undefined}>
        <FormField label="MaxMind account ID" htmlFor={`${fieldId}-account`} required>
          <input
            id={`${fieldId}-account`}
            name="maxmindAccountId"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="123456"
            required
            autoFocus={editing}
          />
        </FormField>
        <FormField label={configured ? "New MaxMind license key" : "MaxMind license key"} htmlFor={`${fieldId}-license`} required>
          <input
            id={`${fieldId}-license`}
            name="maxmindLicenseKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste license key"
            required
          />
        </FormField>
        <div className="keyFormActions">
          {configured && <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>}
          <Button type="submit">{configured ? "Save replacement" : "Save credentials"}</Button>
        </div>
      </fieldset>
    </form>
  );
}

export function ModrinthKeyForm({
  onSubmit,
  configured,
  disabled = false,
  loading = false
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  configured: boolean;
  disabled?: boolean;
  loading?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const fieldId = useId();

  function submitKey(event: FormEvent<HTMLFormElement>) {
    onSubmit(event);
    setEditing(false);
  }

  if (loading) {
    return (
      <div className="keyForm keyFormConfigured keyFormPending" aria-busy="true">
        <LoadingLabel>Loading Modrinth integration status</LoadingLabel>
        <IntegrationControlField label="Modrinth API key" ariaHidden>
          <div className="secretPreview">
            <SkeletonBlock className="integrationKeySkeleton" />
            <SkeletonBlock className="uiSkeleton--badge" />
          </div>
        </IntegrationControlField>
        <div className="keyFormActions" aria-hidden="true">
          <SkeletonBlock className="integrationActionSkeleton" />
        </div>
      </div>
    );
  }

  if (configured && !editing) {
    return (
      <div className="keyForm keyFormConfigured">
        <IntegrationControlField label="Modrinth API key">
          <div className="secretPreview" aria-label="Stored Modrinth API key">
            <code aria-hidden="true">**** **** **** ****</code>
            <StatusBadge tone="success">Configured</StatusBadge>
          </div>
        </IntegrationControlField>
        <div className="keyFormActions">
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={disabled} title={disabled ? "Manage integrations permission is required" : "Replace Modrinth API key"}>Replace key</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submitKey} className="keyForm">
      <fieldset disabled={disabled} title={disabled ? "Manage integrations permission is required" : undefined}>
        <FormField label={configured ? "New Modrinth API key" : "Modrinth API key"} htmlFor={fieldId} required>
          <input
            id={fieldId}
            name="modrinthApiKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste API key"
            required
            // Only ever true after "Replace key" mounted this form, so the page
            // itself never opens with the caret in a credential field.
            autoFocus={editing}
          />
        </FormField>
        <div className="keyFormActions">
          {configured && <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>}
          <Button type="submit">{configured ? "Save replacement" : "Save key"}</Button>
        </div>
      </fieldset>
    </form>
  );
}
