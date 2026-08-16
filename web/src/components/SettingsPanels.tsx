import { FormEvent, useState } from 'react';
import { Button, LoadingLabel, SkeletonBlock, StatusBadge } from './UiPrimitives';

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

  function submitCredentials(event: FormEvent<HTMLFormElement>) {
    onSubmit(event);
    setEditing(false);
  }

  if (loading) {
    return (
      <div className="keyForm keyFormConfigured keyFormPending" aria-busy="true">
        <LoadingLabel>Loading GeoLite2 integration status</LoadingLabel>
        <div className="secretPreview" aria-hidden="true">
          <SkeletonBlock className="integrationKeySkeleton" />
          <SkeletonBlock className="uiSkeleton--badge" />
        </div>
        <div className="keyFormActions" aria-hidden="true">
          <SkeletonBlock className="integrationActionSkeleton" />
        </div>
      </div>
    );
  }

  if (configured && !editing) {
    return (
      <div className="keyForm keyFormConfigured">
        <div className="secretPreview" aria-label="Stored MaxMind credentials">
          <code aria-hidden="true">**** **** **** ****</code>
          <StatusBadge tone="success">Configured</StatusBadge>
        </div>
        <div className="keyFormActions">
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={disabled} title={disabled ? "Manage integrations permission is required" : "Replace MaxMind credentials"}>Replace credentials</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submitCredentials} className="keyForm">
      <fieldset disabled={disabled} title={disabled ? "Manage integrations permission is required" : undefined}>
        <label>
          MaxMind account ID
          <input
            name="maxmindAccountId"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="123456"
            required
            autoFocus={editing}
          />
        </label>
        <label>
          {configured ? "New MaxMind license key" : "MaxMind license key"}
          <input
            name="maxmindLicenseKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste license key"
            required
          />
        </label>
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

  function submitKey(event: FormEvent<HTMLFormElement>) {
    onSubmit(event);
    setEditing(false);
  }

  if (loading) {
    return (
      <div className="keyForm keyFormConfigured keyFormPending" aria-busy="true">
        <LoadingLabel>Loading Modrinth integration status</LoadingLabel>
        <div className="secretPreview" aria-hidden="true">
          <SkeletonBlock className="integrationKeySkeleton" />
          <SkeletonBlock className="uiSkeleton--badge" />
        </div>
        <div className="keyFormActions" aria-hidden="true">
          <SkeletonBlock className="integrationActionSkeleton" />
        </div>
      </div>
    );
  }

  if (configured && !editing) {
    return (
      <div className="keyForm keyFormConfigured">
        <div className="secretPreview" aria-label="Stored Modrinth API key">
          <code aria-hidden="true">**** **** **** ****</code>
          <StatusBadge tone="success">Configured</StatusBadge>
        </div>
        <div className="keyFormActions">
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={disabled} title={disabled ? "Manage integrations permission is required" : "Replace Modrinth API key"}>Replace key</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submitKey} className="keyForm">
      <fieldset disabled={disabled} title={disabled ? "Manage integrations permission is required" : undefined}>
        <label>
          {configured ? "New Modrinth API key" : "Modrinth API key"}
          <input
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
        </label>
        <div className="keyFormActions">
          {configured && <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>}
          <Button type="submit">{configured ? "Save replacement" : "Save key"}</Button>
        </div>
      </fieldset>
    </form>
  );
}
