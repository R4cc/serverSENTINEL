import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { GlassEffect } from "./GlassEffect";
import { useDialogFocus } from "./useDialogFocus";

export function DialogSurface({
  className,
  mobileFullscreen = false,
  labelledBy,
  describedBy,
  onClose,
  initialFocusRef,
  allowDocumentScrollOnPhone = false,
  backdrop,
  dismissible = true,
  backdropDismiss,
  children
}: {
  className: string;
  /** Editing and detail workflows share a viewport-sized mobile surface. */
  mobileFullscreen?: boolean;
  labelledBy: string;
  describedBy?: string;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  allowDocumentScrollOnPhone?: boolean;
  /** Wraps the dialog in `.modalBackdrop`; pass a string to add a modifier class. Drawers omit it. */
  backdrop?: true | string;
  /** When false, Escape and a backdrop click leave the dialog open (e.g. while a save is running). */
  dismissible?: boolean;
  /** Overrides `dismissible` for backdrop clicks only, for dialogs that close on Escape but not on click-outside. */
  backdropDismiss?: boolean;
  children: ReactNode;
}) {
  const closeOnEscape = () => {
    if (dismissible) onClose();
  };
  const closeOnBackdrop = () => {
    if (backdropDismiss ?? dismissible) onClose();
  };
  const dialogRef = useDialogFocus<HTMLElement>({ onClose: closeOnEscape, initialFocusRef, allowDocumentScrollOnPhone });

  const surface = (
    <section
      ref={dialogRef}
      className={`uiGlassSurface uiGlassSurface--modal ${mobileFullscreen ? "uiDialog--mobileFullscreen" : ""} ${className}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      tabIndex={-1}
    >
      <GlassEffect variant="modal" />
      {children}
    </section>
  );

  if (!backdrop) return surface;

  const overlay = (
    <div
      className={backdrop === true ? "modalBackdrop" : `modalBackdrop ${backdrop}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeOnBackdrop();
      }}
    >
      {surface}
    </div>
  );
  // Fixed overlays belong outside page stacking contexts and clipped scroll containers.
  return typeof document === "undefined" ? overlay : createPortal(overlay, document.body);
}
