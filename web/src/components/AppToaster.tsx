import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { CheckCircle2, CircleAlert, Info, TriangleAlert } from "lucide-react";
import { Spinner } from "./UiPrimitives";

function ToastSeverityIcon({ type }: { type: "success" | "info" | "warning" | "error" }) {
  const Icon = type === "success" ? CheckCircle2 : type === "info" ? Info : type === "warning" ? TriangleAlert : CircleAlert;
  return <Icon aria-hidden="true" className="toastSeverityIcon" strokeWidth={2.15} />;
}

// Below this width the app has a top bar of its own (brand and menu) instead of the sidebar.
const topBarLayoutQuery = "(max-width: 1100px)";

function useTopBarLayout() {
  const [topBar, setTopBar] = useState(() => window.matchMedia(topBarLayoutQuery).matches);
  useEffect(() => {
    const media = window.matchMedia(topBarLayoutQuery);
    const update = () => setTopBar(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return topBar;
}

export function AppToaster({ darkMode }: { darkMode: boolean }) {
  const topBar = useTopBarLayout();
  return (
    <Toaster
      closeButton
      expand
      gap={8}
      icons={{
        loading: <Spinner size="sm" tone="current" />,
        success: <ToastSeverityIcon type="success" />,
        info: <ToastSeverityIcon type="info" />,
        warning: <ToastSeverityIcon type="warning" />,
        error: <ToastSeverityIcon type="error" />
      }}
      // Toasts report on the server, so they keep off the things that already show its state. With
      // a top bar, a toast sits over that bar's brand and menu: at the bottom it covered the newest
      // console lines, which are the ones the action just produced, and lower down the top it
      // covered the server's name and status. Wide screens keep the bottom-right corner, raised
      // clear of the panels' bottom rows.
      mobileOffset={{ top: "calc(6px + env(safe-area-inset-top, 0px))", right: "12px", left: "12px" }}
      offset={topBar ? { top: "6px", right: "24px", left: "24px" } : { bottom: "76px", right: "24px" }}
      position={topBar ? "top-center" : "bottom-right"}
      theme={darkMode ? "dark" : "light"}
      toastOptions={{
        className: "sonnerToast",
        descriptionClassName: "sonnerToastDescription"
      }}
      visibleToasts={5}
    />
  );
}
