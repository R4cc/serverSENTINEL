import type { Notice, ProvisionJob } from '../types';

function provisioningTitle(job: ProvisionJob) {
  if (job.status === "succeeded") return "Server created successfully";
  if (job.status === "failed") return "Server setup failed";
  return "Creating server";
}

function provisioningStatus(job: ProvisionJob) {
  if (job.status === "succeeded") return "Complete";
  if (job.status === "failed") return "Failed";
  return "Running";
}

export function Notifications({
  notices,
  provisioningJob,
  onDismissProvisioning
}: {
  notices: Notice[];
  provisioningJob: ProvisionJob | null;
  onDismissProvisioning: () => void;
}) {
  const progress = provisioningJob ? Math.max(0, Math.min(100, provisioningJob.progress)) : 0;
  return (
    <div className="toastRegion">
      {provisioningJob && (
        <div className={`toast provisioningToast ${provisioningJob.status}`} role="status" aria-live="polite">
          <div className="provisioningToastHeader">
            <div>
              <strong>{provisioningTitle(provisioningJob)}</strong>
              <span>{provisioningStatus(provisioningJob)}</span>
            </div>
            {provisioningJob.status !== "running" && (
              <button type="button" className="toastDismissButton" onClick={onDismissProvisioning} aria-label="Dismiss server setup notification">
                x
              </button>
            )}
          </div>
          <p>{provisioningJob.error || provisioningJob.task}</p>
          <div
            className="progressTrack"
            aria-label="Server setup progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            role="progressbar"
          >
            <span style={{ width: `${progress}%` }} />
          </div>
          <small>{Math.round(progress)}%</small>
        </div>
      )}
      {notices.map((notice) => (
        <div key={notice.id} className={`toast ${notice.type}`}>{notice.text}</div>
      ))}
    </div>
  );
}
