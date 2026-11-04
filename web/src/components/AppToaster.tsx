import { Toaster } from "sonner";
import { CheckCircle2, CircleAlert, Info, TriangleAlert } from "lucide-react";
import { Spinner } from "./UiPrimitives";

function ToastSeverityIcon({ type }: { type: "success" | "info" | "warning" | "error" }) {
  const Icon = type === "success" ? CheckCircle2 : type === "info" ? Info : type === "warning" ? TriangleAlert : CircleAlert;
  return <Icon aria-hidden="true" className="toastSeverityIcon" strokeWidth={2.15} />;
}

export function AppToaster({ darkMode, phoneLayout }: { darkMode: boolean; phoneLayout: boolean }) {
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
      // Toasts report on the server, so they stay off the server header that shows its state: at
      // the top of a phone they covered its name and status, and at the top of a wider screen its
      // Start/Stop controls. Both now sit at the bottom, raised clear of the status lines there --
      // the console's command line or stopped notice on a phone (44px plus its safe area), and the
      // panels' bottom rows on a wider screen.
      mobileOffset={{ top: "76px", right: "12px", left: "12px", bottom: "calc(60px + env(safe-area-inset-bottom, 0px))" }}
      offset={{ bottom: "76px", right: "24px" }}
      position={phoneLayout ? "bottom-center" : "bottom-right"}
      theme={darkMode ? "dark" : "light"}
      toastOptions={{
        className: "sonnerToast",
        descriptionClassName: "sonnerToastDescription"
      }}
      visibleToasts={5}
    />
  );
}
