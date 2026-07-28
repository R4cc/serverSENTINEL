import { Toaster } from "sonner";

function ToastSeverityIcon({ type }: { type: "success" | "info" | "warning" | "error" }) {
  if (type === "warning") {
    return (
      <svg aria-hidden="true" className="toastSeverityIcon" viewBox="0 0 24 24" fill="none">
        <path d="M12 3.25 22 20.5H2L12 3.25Z" fill="currentColor" />
        <path d="M12 8.5v5.25" stroke="var(--surface-raised)" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M12 17.25h.01" stroke="var(--surface-raised)" strokeWidth="2.8" strokeLinecap="round" />
      </svg>
    );
  }

  const isError = type === "error";
  const isInfo = type === "info";

  return (
    <svg aria-hidden="true" className="toastSeverityIcon" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      {type === "success" ? (
        <path d="m7.75 12.2 2.65 2.65 5.85-6" stroke="var(--surface-raised)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
      {isInfo ? (
        <>
          <path d="M12 10.5v6" stroke="var(--surface-raised)" strokeWidth="2.3" strokeLinecap="round" />
          <path d="M12 7.2h.01" stroke="var(--surface-raised)" strokeWidth="2.8" strokeLinecap="round" />
        </>
      ) : null}
      {isError ? (
        <>
          <path d="m8.75 8.75 6.5 6.5" stroke="var(--surface-raised)" strokeWidth="2.3" strokeLinecap="round" />
          <path d="m15.25 8.75-6.5 6.5" stroke="var(--surface-raised)" strokeWidth="2.3" strokeLinecap="round" />
        </>
      ) : null}
    </svg>
  );
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
