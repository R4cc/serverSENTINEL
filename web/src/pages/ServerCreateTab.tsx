import { FormEvent, lazy, Suspense } from "react";
import type { ContextNode, GeneralJob } from "../types";
import { InlineState } from "../components/InlineState";
import { FeaturePageLoadingSkeleton } from "../components/LoadingSkeletons";
import { Button } from "../components/UiPrimitives";

export const loadServerCreatePage = () => import("./ServerCreatePage");
const ManagedServerForm = lazy(() => loadServerCreatePage().then((module) => ({ default: module.ManagedServerForm })));

/**
 * The create-server page: live provisioning progress, the failure report from a
 * previous attempt, and the form itself.
 */
export function ServerCreateTab({
  provisionOperation,
  provisioningError,
  provisioningErrorDetails,
  onClearProvisioningError,
  nodes,
  preferredNodeId,
  totalMemory,
  provisioning,
  disabledReason,
  onRefreshNodes,
  onSubmit
}: {
  provisionOperation: GeneralJob | undefined;
  provisioningError: string;
  provisioningErrorDetails: string;
  onClearProvisioningError: () => void;
  nodes: ContextNode[];
  preferredNodeId: string;
  totalMemory?: number;
  provisioning: boolean;
  disabledReason: string;
  onRefreshNodes: () => Promise<void> | void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="createServerPanel">
      {provisionOperation && (provisionOperation.status === "queued" || provisionOperation.status === "running") && (
        <InlineState
          tone="loading"
          title="Creating server"
          message={`${provisionOperation.task || "Server setup is running."} Progress: ${Math.round(provisionOperation.progress)}%.`}
        />
      )}
      {provisioningError && (
        <section className="inlineState inlineState-error" role="alert">
          <div className="inlineStateText">
            <strong>Server setup failed</strong>
            <span>{provisioningError} Review the details below, adjust the form if needed, then try again.</span>
            {provisioningErrorDetails && (
              <details className="failureDetails">
                <summary>Show full API failure log</summary>
                <pre>{provisioningErrorDetails}</pre>
              </details>
            )}
          </div>
          <Button variant="secondary" compact onClick={onClearProvisioningError}>Clear error</Button>
        </section>
      )}
      <Suspense fallback={<FeaturePageLoadingSkeleton label="Loading server form" page="create" />}>
        <ManagedServerForm
          nodes={nodes}
          preferredNodeId={preferredNodeId}
          totalMemory={totalMemory}
          provisioning={provisioning}
          disabledReason={disabledReason}
          onRefreshNodes={onRefreshNodes}
          onSubmit={onSubmit}
        />
      </Suspense>
    </section>
  );
}
