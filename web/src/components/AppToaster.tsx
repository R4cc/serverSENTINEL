import { Toaster } from "sonner";
import { CheckCircle2, CircleAlert, Info, TriangleAlert } from "lucide-react";

function ToastSeverityIcon({ type }: { type: "success" | "info" | "warning" | "error" }) {
  const Icon = type === "success" ? CheckCircle2 : type === "info" ? Info : type === "warning" ? TriangleAlert : CircleAlert;
  return <Icon aria-hidden="true" className="toastSeverityIcon" strokeWidth={2.15} />;
}

export function AppToaster({ darkMode }: { darkMode: boolean }) {
  return (
    <Toaster
      closeButton
      expand
      gap={8}
      icons={{
        success: <ToastSeverityIcon type="success" />,
        info: <ToastSeverityIcon type="info" />,
        warning: <ToastSeverityIcon type="warning" />,
        error: <ToastSeverityIcon type="error" />
      }}
      // The phone shell puts a 68px sticky top bar under the toast stack, and the
      // default 16px mobile offset drops toasts straight onto the brand and the
      // navigation toggle. Clearing the bar keeps both readable at once.
      mobileOffset={{ top: "76px", right: "12px", left: "12px", bottom: "12px" }}
      position="top-center"
      theme={darkMode ? "dark" : "light"}
      toastOptions={{
        className: "sonnerToast",
        descriptionClassName: "sonnerToastDescription"
      }}
      visibleToasts={5}
    />
  );
}
