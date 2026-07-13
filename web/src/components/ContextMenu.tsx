import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type MutableRefObject, type Ref } from "react";
import { createPortal } from "react-dom";
import type { ActionMenuItem } from "./ActionMenu";

export type ContextMenuPoint = { x: number; y: number };
export type ContextMenuSize = { width: number; height: number };
export type ContextMenuViewport = { width: number; height: number };

export function contextMenuPosition(
  point: ContextMenuPoint,
  size: ContextMenuSize,
  viewport: ContextMenuViewport,
  gutter = 8
) {
  const maximumLeft = Math.max(gutter, viewport.width - size.width - gutter);
  const maximumTop = Math.max(gutter, viewport.height - size.height - gutter);
  return {
    left: Math.min(Math.max(point.x, gutter), maximumLeft),
    top: Math.min(Math.max(point.y, gutter), maximumTop)
  };
}

export function ContextMenuSurface({
  id,
  label,
  items,
  left,
  top,
  menuRef,
  itemRefs,
  onSelect
}: {
  id: string;
  label: string;
  items: ActionMenuItem[];
  left: number;
  top: number;
  menuRef?: Ref<HTMLDivElement>;
  itemRefs?: MutableRefObject<Array<HTMLButtonElement | null>>;
  onSelect: (item: ActionMenuItem) => void;
}) {
  return (
    <div
      id={id}
      ref={menuRef}
      className="actionMenuPopover contextMenuPopover"
      role="menu"
      aria-label={label}
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {item.separatorBefore && index > 0 && <div className="actionMenuSeparator" role="separator" />}
          <button
            ref={(node) => { if (itemRefs) itemRefs.current[index] = node; }}
            type="button"
            role="menuitem"
            className={`actionMenuItem ${item.critical ? "actionMenuItem--critical" : ""} ${item.active ? "actionMenuItem--active" : ""}`.trim()}
            disabled={item.disabled}
            aria-current={item.active ? "true" : undefined}
            title={item.title}
            onClick={() => onSelect(item)}
          >
            {item.icon}
            {typeof item.label === "string" ? <span>{item.label}</span> : item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

export function ContextMenu({
  label,
  items,
  x,
  y,
  returnFocus,
  onClose
}: {
  label: string;
  items: ActionMenuItem[];
  x: number;
  y: number;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
}) {
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition(contextMenuPosition(
      { x, y },
      { width: bounds.width, height: bounds.height },
      { width: window.innerWidth, height: window.innerHeight }
    ));
  }, [x, y, items.length]);

  useEffect(() => {
    itemRefs.current.find((item) => item && !item.disabled)?.focus({ preventScroll: true });

    const dismiss = () => onClose();
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) dismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        window.requestAnimationFrame(() => {
          if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
        });
        return;
      }
      if (event.key === "Tab") {
        onClose();
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
      enabled[nextIndex].focus({ preventScroll: true });
    };
    const handleScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      dismiss();
    };

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, []);

  if (typeof document === "undefined") return null;
  const portalTarget = document.querySelector(".appShell") ?? document.body;
  return createPortal(
    <ContextMenuSurface
      id={menuId}
      label={label}
      items={items}
      left={position.left}
      top={position.top}
      menuRef={menuRef}
      itemRefs={itemRefs}
      onSelect={(item) => {
        item.onSelect();
        onClose();
      }}
    />,
    portalTarget
  );
}
