import { Fragment } from "react";
import type { ActivePage } from "../types";
import { isServerWorkspacePage, shouldShowApplicationLoadingSkeleton } from "../app/appConfig";
import { InlineState } from "./InlineState";
import { ActiveServerStripLoadingSkeleton, ApplicationLoadingSkeleton } from "./LoadingSkeletons";
import { Banner } from "./UiPrimitives";

/**
 * The stack of banners, skeletons, and load errors rendered above whichever page
 * is active. Each entry is independent — several can be visible at once.
 */
export function WorkspaceNotices({
  activePage,
  dockerDisconnected,
  provisioningError,
  provisioningErrorDetails,
  notice,
  showApplicationLoading,
  appLoadError,
  appRefreshing,
  onRetryAppLoad
}: {
  activePage: ActivePage;
  dockerDisconnected: boolean;
  provisioningError: string;
  provisioningErrorDetails: string;
  notice: string;
  showApplicationLoading: boolean;
  appLoadError: string;
  appRefreshing: boolean;
  onRetryAppLoad: () => void;
}) {
  return (
    <>
      {dockerDisconnected && (
        <Banner
          tone="error"
          title="Docker integration is not connected."
          message="Local server controls are paused. Connect Docker in Settings, or add a remote node that is online and ready."
        />
      )}

      {provisioningError && activePage === "overview" && (
        <Banner
          tone="error"
          title="Server setup failed"
          message={`${provisioningError} Resolve the reported problem, then try creating the server again.`}
        >
          {provisioningErrorDetails && (
            <details className="failureDetails">
              <summary>Show full API failure log</summary>
              <pre>{provisioningErrorDetails}</pre>
            </details>
          )}
        </Banner>
      )}

      {notice && activePage !== "files" && <Banner tone="info" title={notice} />}

      {showApplicationLoading && shouldShowApplicationLoadingSkeleton(activePage) && (
        <Fragment key="application-loading">
          {isServerWorkspacePage(activePage) && <ActiveServerStripLoadingSkeleton />}
          <ApplicationLoadingSkeleton page={activePage} />
        </Fragment>
      )}

      {appLoadError && (
        <InlineState
          tone="error"
          title="Could not load application state"
          message={`${appLoadError} Check that the serverSENTINEL backend is reachable, then try again.`}
          actionLabel="Retry"
          onAction={onRetryAppLoad}
          busy={appRefreshing}
        />
      )}
    </>
  );
}
