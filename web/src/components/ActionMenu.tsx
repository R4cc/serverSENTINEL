import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./UiPrimitives";

export type ActionMenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  critical?: boolean;
  title?: string;
};

export function ActionMenu({
  label,
  items,
  trigger,
  disabled = false,
  className = "",
  triggerClassName = "",
  menuClassName = "",
  align = "end"
}: {
  label: string;
  items: ActionMenuItem[];
  trigger: ReactNode;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    const firstEnabled = itemRefs.current.find((item) => item && !item.disabled);
    firstEnabled?.focus({ preventScroll: true });

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      const enabled = itemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item && !item.disabled));
      if (!enabled.length) return;
      const currentIndex = enabled.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? enabled.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1 + enabled.length) % enabled.length
            : (currentIndex - 1 + enabled.length) % enabled.length;
      enabled[nextIndex].focus();
    };

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className={`actionMenu ${className}`.trim()} ref={containerRef}>
      <Button
        ref={triggerRef}
        variant="secondary"
        iconOnly
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
      {open && (
        <div id={menuId} className={`actionMenuPopover actionMenuPopover--${align} ${menuClassName}`.trim()} role="menu" aria-label={label}>
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => { itemRefs.current[index] = node; }}
              type="button"
              role="menuitem"
              className={`actionMenuItem ${item.critical ? "actionMenuItem--critical" : ""}`.trim()}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                item.onSelect();
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
