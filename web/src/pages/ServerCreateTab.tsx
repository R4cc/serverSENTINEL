import { FormEvent, Suspense } from "react";
import { lazyPage } from "../app/lazyPage";
import type { ContextNode, GeneralJob } from "../types";
import { InlineState } from "../components/InlineState";
import { FeaturePageLoadingSkeleton } from "../components/LoadingSkeletons";
import { Banner, Button } from "../components/UiPrimitives";

const { Component: ManagedServerForm, preload: loadServerCreatePage } = lazyPage(
  () => import("./ServerCreatePage"),
  (module) => module.ManagedServerForm
);
export { loadServerCreatePage };

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
        <Banner
          tone="error"
          title="Server setup failed"
          message={`${provisioningError} Review the details below, resolve the reported problem, then try again.`}
          action={<Button variant="secondary" compact onClick={onClearProvisioningError}>Clear error</Button>}
        >
          {provisioningErrorDetails && (
            <details className="failureDetails">
              <summary>Show full API failure log</summary>
              <pre>{provisioningErrorDetails}</pre>
            </details>
          )}
        </Banner>
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
