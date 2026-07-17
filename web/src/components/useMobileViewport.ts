import { useEffect, useState } from "react";

const phoneLayoutQuery = "(max-width: 720px)";

function viewportHeight() {
  return Math.round(window.visualViewport?.height ?? window.innerHeight);
}

export function useMobileViewport() {
  const [phoneLayout, setPhoneLayout] = useState(() => window.matchMedia(phoneLayoutQuery).matches);

  useEffect(() => {
    const phoneLayoutMedia = window.matchMedia(phoneLayoutQuery);
    const visualViewport = window.visualViewport;
    const synchronizeViewport = () => {
      setPhoneLayout(phoneLayoutMedia.matches);
      document.documentElement.style.setProperty("--visual-viewport-height", `${viewportHeight()}px`);
    };

    synchronizeViewport();
    phoneLayoutMedia.addEventListener("change", synchronizeViewport);
    visualViewport?.addEventListener("resize", synchronizeViewport);
    window.addEventListener("resize", synchronizeViewport);

    return () => {
      phoneLayoutMedia.removeEventListener("change", synchronizeViewport);
      visualViewport?.removeEventListener("resize", synchronizeViewport);
      window.removeEventListener("resize", synchronizeViewport);
      document.documentElement.style.removeProperty("--visual-viewport-height");
    };
  }, []);

  return phoneLayout;
}

export function useWideTimelineViewport() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 981px)").matches);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 981px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return wide;
}
