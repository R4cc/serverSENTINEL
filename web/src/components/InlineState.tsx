import { Banner, Button, Spinner } from "./UiPrimitives";

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
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  busy?: boolean;
}) {
  const action = onAction && actionLabel
    ? (
      <Button variant="secondary" compact onClick={onAction} disabled={busy} aria-busy={busy} reserveLabel={actionLabel.length > "Working...".length ? actionLabel : "Working..."}>
        {busy ? "Working..." : actionLabel}
      </Button>
    )
    : undefined;

  if (tone === "error" || tone === "warning") {
    return <Banner tone={tone} title={title} message={message} action={action} className={`inlineState inlineState-${tone}`} />;
  }

  return (
    <div className={`inlineState inlineState-${tone}`} role="status">
      {tone === "loading" && <Spinner size="md" className="inlineStateSpinner" />}
      <div>
        <strong>{title}</strong>
        {message && <span>{message}</span>}
      </div>
      {action}
    </div>
  );
}
