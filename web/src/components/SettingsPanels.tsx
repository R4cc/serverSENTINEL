import { FormEvent, useState } from 'react';
import { Button, LoadingLabel, SkeletonBlock, StatusBadge } from './UiPrimitives';

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
          <StatusBadge tone="success" className="settingsStatus ready">Configured</StatusBadge>
        </div>
        <div className="keyFormActions">
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={disabled} title={disabled ? "Manage integrations permission is required" : "Replace Modrinth API key"}>Replace key</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submitKey} className="keyForm">
      <fieldset disabled={disabled}>
        <label>
          {configured ? "New Modrinth API key" : "Modrinth API key"}
          <input
            name="modrinthApiKey"
            type="password"
            autoComplete="off"
            placeholder="Paste API key"
            required
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
