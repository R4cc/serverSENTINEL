import type { Notice, GeneralJob, OverviewLoadToast } from '../types';

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
  overviewLoadToast,
  onDismissJob,
  onDismissNotice
}: {
  notices: Notice[];
  activeJobs: GeneralJob[];
  overviewLoadToast: OverviewLoadToast | null;
  onDismissJob: (id: string) => void;
  onDismissNotice: (id: number) => void;
}) {
  return (
    <div className="toastRegion">
      {overviewLoadToast && (
        <div className={`toast overviewLoadToast toast-${overviewLoadToast.status}`} role="status" aria-live="polite">
          <div className="toastHeader">
            <div className="toastTitleGroup">
              <strong>{overviewLoadToast.status === "running" ? "Loading overview" : "Overview updated"}</strong>
              <span>{overviewLoadToast.status === "running" ? "Loading" : "Complete"}</span>
            </div>
            <span
              className={`toastStatusIcon toastStatusIcon-${overviewLoadToast.status}`}
              aria-hidden="true"
            />
          </div>
          <p className="toastMessage">
            {overviewLoadToast.status === "running"
              ? "Loading server activity, health, and recent events."
              : "Server activity, health, and recent events are up to date."}
          </p>
        </div>
      )}
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
            <button
              type="button"
              className="toastDismissButton"
              onClick={() => onDismissNotice(notice.id)}
              aria-label={`Dismiss ${noticeLabels[notice.type]} notification`}
            >
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
          <p className="toastMessage">{notice.text}</p>
        </div>
      ))}
    </div>
  );
}
