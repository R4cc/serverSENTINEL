import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "critical";
type StatusTone = "neutral" | "accent" | "success" | "warning" | "danger";

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function Button({
  variant = "primary",
  compact = false,
  iconOnly = false,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  compact?: boolean;
  iconOnly?: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      className={classes("uiButton", `uiButton--${variant}`, compact && "uiButton--compact", iconOnly && "uiButton--icon", className)}
    />
  );
}

export function StatusBadge({
  tone = "neutral",
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: StatusTone;
}) {
  return <span {...props} className={classes("uiStatusBadge", `uiStatusBadge--${tone}`, className)}>{children}</span>;
}

export function PanelHeader({
  title,
  description,
  actions,
  className
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={classes("uiPanelHeader", className)}>
      <div className="uiPanelHeaderCopy">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="uiPanelHeaderActions">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  title,
  message,
  action,
  compact = false,
  className
}: {
  title: ReactNode;
  message?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={classes("uiEmptyState", compact && "uiEmptyState--compact", className)}>
      <strong>{title}</strong>
      {message && <span>{message}</span>}
      {action}
    </div>
  );
}
