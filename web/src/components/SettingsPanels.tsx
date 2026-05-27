import { FormEvent, useEffect, useState } from 'react';
import type { ProvisionJob } from '../types';

export function ProvisionProgress({ job }: { job: ProvisionJob }) {
  return (
    <section className={`provisionPanel ${job.status}`}>
      <div>
        <strong>{job.status === "failed" ? "Setup stopped" : job.status === "succeeded" ? "Setup complete" : "Setting up server"}</strong>
        <span>{job.error || job.task}</span>
      </div>
      <div className="progressTrack" aria-label="Server setup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress} role="progressbar">
        <span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
      </div>
      <small>{Math.round(job.progress)}%</small>
    </section>
  );
}

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
          <span className="settingsStatus ready">Configured</span>
          <code aria-hidden="true">**** **** **** ****</code>
        </div>
        <button type="button" className="secondaryButton" onClick={() => setEditing(true)} disabled={disabled}>Replace key</button>
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
        {configured && <button type="button" className="secondaryButton" onClick={() => setEditing(false)}>Cancel</button>}
        <button>{configured ? "Save replacement" : "Save key"}</button>
      </div>
      </fieldset>
    </form>
  );
}
