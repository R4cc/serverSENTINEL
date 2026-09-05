type PageWindow = Pick<Window, "addEventListener" | "removeEventListener">;
type PageDocument = Pick<Document, "addEventListener" | "removeEventListener" | "hidden">;

export type PageReactivationTargets = {
  windowTarget: PageWindow;
  documentTarget: PageDocument;
};

/**
 * Runs a refresh as soon as a backgrounded or disconnected page becomes usable again.
 * Browsers throttle intervals in background tabs, so polling alone can leave a restored page
 * displaying an old loading state long after the backend has recovered.
 */
export function subscribeToPageReactivation(
  refresh: () => void,
  targets: PageReactivationTargets = { windowTarget: window, documentTarget: document }
) {
  let lastRefresh = -Infinity;
  const refreshWhenVisible = () => {
    // A restored tab emits focus, pageshow and visibilitychange together. Keep the first
    // refresh immediate without cancelling and restarting it for the rest of that burst.
    const now = Date.now();
    if (!targets.documentTarget.hidden && now - lastRefresh >= 250) {
      lastRefresh = now;
      refresh();
    }
  };

  targets.windowTarget.addEventListener("focus", refreshWhenVisible);
  targets.windowTarget.addEventListener("online", refreshWhenVisible);
  targets.windowTarget.addEventListener("pageshow", refreshWhenVisible);
  targets.documentTarget.addEventListener("visibilitychange", refreshWhenVisible);

  return () => {
    targets.windowTarget.removeEventListener("focus", refreshWhenVisible);
    targets.windowTarget.removeEventListener("online", refreshWhenVisible);
    targets.windowTarget.removeEventListener("pageshow", refreshWhenVisible);
    targets.documentTarget.removeEventListener("visibilitychange", refreshWhenVisible);
  };
}
