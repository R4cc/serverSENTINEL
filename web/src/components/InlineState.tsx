export function InlineState({
  tone = "info",
  title,
  message,
  actionLabel,
  onAction,
  busy = false
}: {
  tone?: "info" | "loading" | "error" | "warning" | "empty";
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  busy?: boolean;
}) {
  return (
    <div className={`inlineState inlineState-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {tone === "loading" && <span className="inlineStateSpinner" aria-hidden="true" />}
      <div>
        <strong>{title}</strong>
        <span>{message}</span>
      </div>
      {onAction && actionLabel && (
        <button type="button" className="secondaryButton" onClick={onAction} disabled={busy}>
          {busy ? "Working..." : actionLabel}
        </button>
      )}
    </div>
  );
}
