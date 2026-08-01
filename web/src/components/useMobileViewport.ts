import { useEffect, useState } from "react";

const phoneLayoutQuery = "(max-width: 720px)";
export const overviewTimelineQuery = "(min-width: 981px), (orientation: landscape)";

function viewportHeight() {
  return Math.round(window.visualViewport?.height ?? window.innerHeight);
}

/**
 * How far the visible area has been pushed down the page it sits in. Opening the keyboard shrinks
 * the visual viewport, and iOS may then slide it down the layout viewport to bring the focused
 * field into view. Anything sized to the visible area has to move with it, or it keeps the height
 * of what can be seen while staying where what could be seen used to start.
 */
function viewportOffsetTop() {
  return Math.round(window.visualViewport?.offsetTop ?? 0);
}

export function useMobileViewport() {
  const [phoneLayout, setPhoneLayout] = useState(() => window.matchMedia(phoneLayoutQuery).matches);

  useEffect(() => {
    const phoneLayoutMedia = window.matchMedia(phoneLayoutQuery);
    const visualViewport = window.visualViewport;
    const synchronizeViewport = () => {
      setPhoneLayout(phoneLayoutMedia.matches);
      document.documentElement.style.setProperty("--visual-viewport-height", `${viewportHeight()}px`);
      document.documentElement.style.setProperty("--visual-viewport-offset-top", `${viewportOffsetTop()}px`);
    };

    synchronizeViewport();
    phoneLayoutMedia.addEventListener("change", synchronizeViewport);
    visualViewport?.addEventListener("resize", synchronizeViewport);
    // The visual viewport can slide without resizing, which is how it moves once the keyboard has
    // finished opening. Listening only for `resize` reads the offset it had on the way there.
    visualViewport?.addEventListener("scroll", synchronizeViewport);
    window.addEventListener("resize", synchronizeViewport);

    return () => {
      phoneLayoutMedia.removeEventListener("change", synchronizeViewport);
      visualViewport?.removeEventListener("resize", synchronizeViewport);
      visualViewport?.removeEventListener("scroll", synchronizeViewport);
      window.removeEventListener("resize", synchronizeViewport);
      document.documentElement.style.removeProperty("--visual-viewport-height");
      document.documentElement.style.removeProperty("--visual-viewport-offset-top");
    };
  }, []);

  return phoneLayout;
}

export function shouldShowOverviewTimeline(width: number, height: number) {
  return width >= 981 || width > height;
}

export function useOverviewTimelineVisibility() {
  const [visible, setVisible] = useState(() => window.matchMedia(overviewTimelineQuery).matches);

  useEffect(() => {
    const media = window.matchMedia(overviewTimelineQuery);
    const update = () => setVisible(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return visible;
}
