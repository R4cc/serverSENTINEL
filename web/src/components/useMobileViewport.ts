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
