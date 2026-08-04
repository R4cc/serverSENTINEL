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
