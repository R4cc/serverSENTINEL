import {
  createElement,
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, CircleAlert, CircleHelp, Info, TriangleAlert } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "critical";
type StatusTone = "neutral" | "accent" | "success" | "warning" | "danger";
type SurfaceElement = "section" | "article" | "aside" | "div";
type SurfaceDensity = "default" | "compact" | "flush";
type SurfaceTone = "default" | "subtle";
type SurfaceMaterial = "glass" | "solid";
type BannerTone = "info" | "success" | "warning" | "error";
type MetricTone = "neutral" | "info" | "accent" | "success" | "warning" | "danger";
type MetricVariant = "default" | "summary";
type SpinnerSize = "xs" | "sm" | "md" | "lg";
type SpinnerTone = "accent" | "current";

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
  help,
  actions,
  className,
  headingLevel = 2,
  compact = false
}: {
  title: ReactNode;
  description?: ReactNode;
  help?: ReactNode;
  actions?: ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
  compact?: boolean;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <header className={classes("uiPanelHeader", compact && "uiPanelHeader--compact", className)}>
      <div className="uiPanelHeaderCopy">
        <div className="uiPanelHeaderTitle"><Heading>{title}</Heading>{help}</div>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="uiPanelHeaderActions">{actions}</div>}
    </header>
  );
}

export function HelpTooltip({
  label,
  children,
  id,
  className,
  trigger
}: {
  label: string;
  children: ReactNode;
  id?: string;
  className?: string;
  trigger?: ReactNode;
}) {
  const generatedId = useId();
  const tooltipId = id ?? `ui-help-${generatedId.replace(/:/g, "")}`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const pinnedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });

  useLayoutEffect(() => {
    if (!open) return undefined;
    const updatePosition = () => {
      const button = buttonRef.current;
      const content = contentRef.current;
      if (!button || !content) return;
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const viewportLeft = window.visualViewport?.offsetLeft ?? 0;
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      const buttonRect = button.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const left = Math.min(
        Math.max(viewportLeft + 8, buttonRect.left + buttonRect.width / 2 - contentRect.width / 2),
        Math.max(viewportLeft + 8, viewportLeft + viewportWidth - contentRect.width - 8)
      );
      const below = buttonRect.bottom + 8;
      const above = buttonRect.top - contentRect.height - 8;
      const top = below + contentRect.height <= viewportTop + viewportHeight - 8
        ? below
        : Math.max(viewportTop + 8, above);
      setPosition({ left, top });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node
        && !rootRef.current?.contains(event.target)
        && !contentRef.current?.contains(event.target)) {
        pinnedRef.current = false;
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [open]);

  const style: CSSProperties = { left: position.left, top: position.top };

  return (
    <span
      ref={rootRef}
      className={classes("uiHelpTooltip", open && "uiHelpTooltip--open", className)}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") setOpen(true); }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse"
          && !pinnedRef.current
          && !(event.relatedTarget instanceof Node && contentRef.current?.contains(event.relatedTarget))
          && !rootRef.current?.contains(document.activeElement)
          && !contentRef.current?.contains(document.activeElement)) setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!pinnedRef.current
          && !event.currentTarget.contains(event.relatedTarget)
          && !(event.relatedTarget instanceof Node && contentRef.current?.contains(event.relatedTarget))) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          buttonRef.current?.focus();
          pinnedRef.current = false;
          setOpen(false);
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="uiHelpTooltipButton"
        aria-label={`About ${label}`}
        aria-describedby={tooltipId}
        aria-controls={tooltipId}
        aria-expanded={open}
        onClick={() => {
          pinnedRef.current = true;
          setOpen(true);
        }}
      >
        {trigger ?? <CircleHelp aria-hidden="true" />}
      </button>
      {typeof document === "undefined"
        ? <span ref={contentRef} id={tooltipId} role="tooltip" className={classes("uiHelpTooltipContent", open && "uiHelpTooltipContent--open")} style={style}>{children}</span>
        : createPortal(<span ref={contentRef} id={tooltipId} role="tooltip" className={classes("uiHelpTooltipContent", open && "uiHelpTooltipContent--open")} style={style}>{children}</span>, document.body)}
    </span>
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

/**
 * The one busy indicator. Always decorative — the surrounding `role="status"`
 * region or button label is what announces progress, so this stays hidden from
 * assistive technology and reduces to a static ring under reduced motion.
 */
export function Spinner({
  size = "md",
  tone = "accent",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  size?: SpinnerSize;
  tone?: SpinnerTone;
}) {
  return (
    <span
      {...props}
      className={classes("uiSpinner", `uiSpinner--${size}`, tone !== "accent" && `uiSpinner--${tone}`, className)}
      aria-hidden="true"
    />
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

export const Surface = forwardRef<HTMLElement, HTMLAttributes<HTMLElement> & {
  as?: SurfaceElement;
  density?: SurfaceDensity;
  tone?: SurfaceTone;
  material?: SurfaceMaterial;
}>(function Surface({
  as = "section",
  density = "default",
  tone = "default",
  material = "glass",
  className,
  children,
  ...props
}, ref) {
  const Tag = as;
  return createElement(
    Tag,
    {
      ...props,
      ref,
      className: classes(
        "uiSurface",
        `uiSurface--${density}`,
        `uiSurface--${tone}`,
        `uiSurface--${material}`,
        material === "glass" && "uiGlassSurface",
        className
      )
    },
    children
  );
});

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
  help,
  error,
  required = false,
  htmlFor,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  label: ReactNode;
  description?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
}) {
  return (
    <div {...props} className={classes("uiFormField", Boolean(error) && "uiFormField--error", className)}>
      <div className="uiFormFieldLabelRow">
        <label htmlFor={htmlFor} className="uiFormFieldLabel">
          <span>{label}</span>
          {required && <span className="uiFormFieldRequired" aria-hidden="true">Required</span>}
        </label>
        {help}
      </div>
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
  icon,
  compact = false,
  className,
  children,
  role,
  ...props
}: HTMLAttributes<HTMLElement> & {
  tone?: BannerTone;
  title: ReactNode;
  message?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  const ToneIcon = tone === "success" ? CheckCircle2 : tone === "warning" ? TriangleAlert : tone === "error" ? CircleAlert : Info;
  const resolvedRole = role ?? (tone === "error" ? "alert" : tone === "warning" ? "status" : undefined);

  return (
    <section {...props} role={resolvedRole} className={classes("uiBanner", `uiBanner--${tone}`, compact && "uiBanner--compact", className)}>
      <span className="uiBannerIcon" aria-hidden="true">
        {icon ?? <ToneIcon />}
      </span>
      <div className="uiBannerCopy">
        <strong>{title}</strong>
        {message && <div className="uiBannerMessage">{message}</div>}
        {children && <div className="uiBannerDetails">{children}</div>}
      </div>
      {action && <div className="uiBannerAction">{action}</div>}
    </section>
  );
}

export function MetricTile({
  label,
  value,
  detail,
  icon,
  iconPlacement = "label",
  tone = "neutral",
  variant = "default",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  /**
   * Rides with the label rather than taking a column of its own, so naming the metric costs the
   * value no width. The label already says what the tile measures, which makes this decoration —
   * it stays out of the accessibility tree.
   */
  icon?: ReactNode;
  /**
   * `leading` moves the icon into the marker column instead, so the marker reads as a container
   * holding the icon. It costs the value the width the marker already took, which is why a tile
   * that has room for a wide value keeps the default.
   */
  iconPlacement?: "label" | "leading";
  tone?: MetricTone;
  variant?: MetricVariant;
}) {
  const leadingIcon = Boolean(icon) && iconPlacement === "leading";

  return (
    <article {...props} className={classes("uiMetricTile", `uiMetricTile--${tone}`, variant !== "default" && `uiMetricTile--${variant}`, leadingIcon && "uiMetricTile--leadingIcon", className)}>
      <span className="uiMetricTileMarker" aria-hidden="true">{leadingIcon ? icon : null}</span>
      <div className="uiMetricTileCopy">
        <span className={classes("uiMetricTileLabel", icon && !leadingIcon ? "uiMetricTileLabel--withIcon" : undefined)}>
          {icon && !leadingIcon && <span className="uiMetricTileIcon" aria-hidden="true">{icon}</span>}
          {label}
        </span>
        <strong>{value}</strong>
        {detail && <span className="uiMetricTileDetail">{detail}</span>}
      </div>
    </article>
  );
}
