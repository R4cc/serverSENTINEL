import type { Notice, GeneralJob } from '../types';

const noticeLabels: Record<Notice["type"], string> = {
  error: "Error",
  info: "Info",
  success: "Success",
  warning: "Warning"
};

const jobStatusLabels: Record<GeneralJob["status"], string> = {
  failed: "Failed",
  running: "Running",
  succeeded: "Complete"
};

export function Notifications({
  notices,
  activeJobs,
  onDismissJob
}: {
  notices: Notice[];
  activeJobs: GeneralJob[];
  onDismissJob: (id: string) => void;
}) {
  return (
    <div className="toastRegion">
      {activeJobs.map((job) => {
        const progress = Math.max(0, Math.min(100, job.progress));
        const statusLabel = jobStatusLabels[job.status];
        return (
          <div key={job.id} className={`toast provisioningToast toast-${job.status}`} role="status" aria-live="polite">
            <div className="toastHeader">
              <div className="toastTitleGroup">
                <strong>{job.title}</strong>
                <span>{statusLabel}</span>
              </div>
              {job.dismissible && (
                <button
                  type="button"
                  className="toastDismissButton"
                  onClick={() => onDismissJob(job.id)}
                  aria-label={`Dismiss ${job.title} notification`}
                >
                  <span aria-hidden="true">&times;</span>
                </button>
              )}
            </div>
            {job.subject && (
              <p className="toastSubject">
                {job.subject}
              </p>
            )}
            <p className="toastMessage">{job.error || job.task}</p>
            <div
              className="progressTrack"
              aria-label={`${job.title} progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              role="progressbar"
            >
              <span style={{ width: `${progress}%` }} />
            </div>
            <small>{Math.round(progress)}%</small>
          </div>
        );
      })}
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={`toast toast-${notice.type}`}
          role={notice.type === "error" ? "alert" : "status"}
          aria-live={notice.type === "error" ? "assertive" : "polite"}
        >
          <div className="toastHeader">
            <div className="toastTitleGroup">
              <strong>{noticeLabels[notice.type]}</strong>
            </div>
          </div>
          <p className="toastMessage">{notice.text}</p>
        </div>
      ))}
    </div>
  );
}
