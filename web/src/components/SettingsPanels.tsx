import { FormEvent, useEffect, useState } from 'react';
import { Button, StatusBadge } from './UiPrimitives';

export function ModrinthKeyForm({
  onSubmit,
  configured,
  disabled = false
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  configured: boolean;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(!configured);

  useEffect(() => {
    setEditing(!configured);
  }, [configured]);

  function submitKey(event: FormEvent<HTMLFormElement>) {
    onSubmit(event);
    setEditing(false);
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
