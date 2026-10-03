import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./UiPrimitives";
import { focusNextMenuItem } from "./menuFocus";
import { GlassEffect } from "./GlassEffect";

export type ActionMenuItem = {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  critical?: boolean;
  active?: boolean;
  title?: string;
  separatorBefore?: boolean;
};

export function ActionMenu({
  label,
  items,
  trigger,
  iconOnly = true,
  disabled = false,
  className = "",
  triggerClassName = "",
  menuClassName = "",
  portal = false,
  align = "end"
}: {
  label: string;
  items: ActionMenuItem[];
  trigger: ReactNode;
  iconOnly?: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  /** Escape clipped table and panel containers while keeping the menu anchored to its trigger. */
  portal?: boolean;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useLayoutEffect(() => {
    if (!open || !portal) return;
    const place = () => {
      const menu = menuRef.current;
      const trigger = triggerRef.current;
      if (!menu || !trigger) return;
      const bounds = trigger.getBoundingClientRect();
      const gutter = 8;
      const below = Math.max(0, window.innerHeight - bounds.bottom - gutter * 2);
      const above = Math.max(0, bounds.top - gutter * 2);
      const height = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
      const downward = height <= below || (height > above && below >= above);
      const maxHeight = downward ? below : above;
      const left = align === "end" ? bounds.right - menu.offsetWidth : bounds.left;
      setPosition({
        left: Math.max(gutter, Math.min(left, window.innerWidth - menu.offsetWidth - gutter)),
        top: Math.max(gutter, downward ? bounds.bottom + gutter : bounds.top - Math.min(height, maxHeight) - gutter),
        maxHeight
      });
    };
    const dismissOnScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, [open, portal, align, items.length]);

  useEffect(() => {
    if (!open) return;
    const firstEnabled = itemRefs.current.find((item) => item && !item.disabled);
    firstEnabled?.focus({ preventScroll: true });

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
        return;
      }
      if (portal && event.key === "Tab") {
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
        return;
      }
      focusNextMenuItem(event, itemRefs.current);
    };

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, portal]);

  const menu = open && (
    <div ref={menuRef} id={menuId} className={`actionMenuPopover uiGlassSurface uiGlassSurface--floating actionMenuPopover--${align} ${portal ? "actionMenuPopover--portal" : ""} ${menuClassName}`.trim()} role="menu" aria-label={label}
      style={portal ? { position: "fixed", right: "auto", bottom: "auto", ...position } : undefined}>
      <GlassEffect variant="floating" />
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {item.separatorBefore && index > 0 && <div className="actionMenuSeparator" role="separator" />}
          <button
            ref={(node) => { itemRefs.current[index] = node; }}
            type="button"
            role="menuitem"
            className={`actionMenuItem ${item.critical ? "actionMenuItem--critical" : ""} ${item.active ? "actionMenuItem--active" : ""}`.trim()}
            disabled={item.disabled}
            aria-current={item.active ? "true" : undefined}
            title={item.title}
            onClick={() => {
              item.onSelect();
              setOpen(false);
              triggerRef.current?.focus({ preventScroll: true });
            }}
          >
            {item.icon}
            {typeof item.label === "string" ? <span>{item.label}</span> : item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );

  return (
    <div className={`actionMenu ${className}`.trim()} ref={containerRef}>
      <Button
        ref={triggerRef}
        variant="secondary"
        iconOnly={iconOnly}
        className={`actionMenuTrigger ${triggerClassName}`.trim()}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled || items.length === 0}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={label}
      >
        {trigger}
      </Button>
      {portal && typeof document !== "undefined" ? createPortal(menu, document.body) : menu}
    </div>
  );
}
