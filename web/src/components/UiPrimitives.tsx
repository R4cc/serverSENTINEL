import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "critical";
type StatusTone = "neutral" | "accent" | "success" | "warning" | "danger";
type SurfaceElement = "section" | "article" | "aside" | "div";
type SurfaceDensity = "default" | "compact" | "flush";
type SurfaceTone = "default" | "subtle";
type BannerTone = "info" | "success" | "warning" | "error";
type MetricTone = "neutral" | "accent" | "success" | "warning" | "danger";

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  compact?: boolean;
  iconOnly?: boolean;
  reserveLabel?: ReactNode;
}>(function Button({
  variant = "primary",
  compact = false,
  iconOnly = false,
  reserveLabel,
  className,
  children,
  type = "button",
  ...props
}, ref) {
  const reserveContent = Boolean(reserveLabel) && !iconOnly;

  return (
    <button
      ref={ref}
      {...props}
      type={type}
      className={classes("uiButton", `uiButton--${variant}`, compact && "uiButton--compact", iconOnly && "uiButton--icon", reserveContent && "uiButton--reserved", className)}
    >
      {reserveContent ? (
        <span className="uiButtonStableContent">
          <span className="uiButtonReserveContent" aria-hidden="true">{reserveLabel}</span>
          <span className="uiButtonVisibleContent">{children}</span>
        </span>
      ) : children}
    </button>
  );
});

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
  className,
  headingLevel = 2,
  compact = false
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
  compact?: boolean;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <header className={classes("uiPanelHeader", compact && "uiPanelHeader--compact", className)}>
      <div className="uiPanelHeaderCopy">
        <Heading>{title}</Heading>
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

export function SkeletonBlock({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={classes("uiSkeleton", className)} aria-hidden="true" />;
}

export function LoadingLabel({ children }: { children: ReactNode }) {
  return <span className="srOnly" role="status">{children}</span>;
}

export function Surface({
  as = "section",
  density = "default",
  tone = "default",
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: SurfaceElement;
  density?: SurfaceDensity;
  tone?: SurfaceTone;
}) {
  const Tag = as;
  return (
    <Tag {...props} className={classes("uiSurface", `uiSurface--${density}`, `uiSurface--${tone}`, className)}>
      {children}
    </Tag>
  );
}

export function Toolbar({
  primary,
  secondary,
  meta,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  primary?: ReactNode;
  secondary?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div {...props} className={classes("uiToolbar", className)}>
      {primary && <div className="uiToolbarPrimary">{primary}</div>}
      {meta && <div className="uiToolbarMeta">{meta}</div>}
      {secondary && <div className="uiToolbarSecondary">{secondary}</div>}
    </div>
  );
}

export function FormField({
  label,
  description,
  error,
  required = false,
  htmlFor,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
}) {
  return (
    <div {...props} className={classes("uiFormField", Boolean(error) && "uiFormField--error", className)}>
      <label htmlFor={htmlFor} className="uiFormFieldLabel">
        <span>{label}</span>
        {required && <span className="uiFormFieldRequired" aria-hidden="true">Required</span>}
      </label>
      {description && <span className="uiFormFieldDescription">{description}</span>}
      <div className="uiFormFieldControl">{children}</div>
      {error && <span className="uiFormFieldError" role="alert">{error}</span>}
    </div>
  );
}

export function Banner({
  tone = "info",
  title,
  message,
  action,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & {
  tone?: BannerTone;
  title: ReactNode;
  message?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section {...props} role={tone === "error" ? "alert" : props.role} className={classes("uiBanner", `uiBanner--${tone}`, className)}>
      <div className="uiBannerCopy">
        <strong>{title}</strong>
        {message && <span>{message}</span>}
      </div>
      {action && <div className="uiBannerAction">{action}</div>}
    </section>
  );
}

export function MetricTile({
  label,
  value,
  detail,
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  tone?: MetricTone;
}) {
  return (
    <article {...props} className={classes("uiMetricTile", `uiMetricTile--${tone}`, className)}>
      <span className="uiMetricTileMarker" aria-hidden="true" />
      <div className="uiMetricTileCopy">
        <span className="uiMetricTileLabel">{label}</span>
        <strong>{value}</strong>
        {detail && <span className="uiMetricTileDetail">{detail}</span>}
      </div>
    </article>
  );
}
