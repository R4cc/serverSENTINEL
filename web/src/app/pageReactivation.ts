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
  const refreshWhenVisible = () => {
    if (!targets.documentTarget.hidden) refresh();
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
