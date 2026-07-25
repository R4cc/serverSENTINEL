const coverViewport = "width=device-width, initial-scale=1.0, viewport-fit=cover";

/**
 * The narrow surface this needs from a window, so it stays callable from the node test
 * environment the rest of the web suite runs in.
 */
export interface ViewportHost {
  /** iOS reports a home-screen launch through this legacy flag rather than the media query. */
  navigator: { standalone?: boolean };
  matchMedia: (query: string) => { matches: boolean };
  document: { querySelector: (selector: string) => { setAttribute: (name: string, value: string) => void } | null };
}

export function isStandaloneDisplay(view: ViewportHost) {
  if (view.navigator.standalone) return true;
  return view.matchMedia("(display-mode: standalone)").matches;
}

/**
 * Only a home-screen install owns the display cutouts, and only there does the app have to
 * clear them itself. Inside a browser tab, viewport-fit=cover extends the layout viewport
 * beneath the browser's own toolbars: the shell is sized to the visual viewport but stays
 * anchored to the top of that taller layout viewport, so it stops short of the bottom edge
 * and leaves a band the page cannot paint. Without cover the two viewports coincide and the
 * composer lands flush against the toolbar.
 */
export function applyStandaloneViewport(view: ViewportHost = window) {
  if (!isStandaloneDisplay(view)) return false;
  const viewport = view.document.querySelector('meta[name="viewport"]');
  if (!viewport) return false;
  viewport.setAttribute("content", coverViewport);
  return true;
}
