import type { ReactNode } from "react";
import { useDialogFocus } from "./useDialogFocus";

export function DialogSurface({
  className,
  labelledBy,
  describedBy,
  onClose,
  allowDocumentScrollOnPhone = false,
  backdrop,
  dismissible = true,
  backdropDismiss,
  children
}: {
  className: string;
  labelledBy: string;
  describedBy?: string;
  onClose: () => void;
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
  const dialogRef = useDialogFocus<HTMLElement>({ onClose: closeOnEscape, allowDocumentScrollOnPhone });

  const surface = (
    <section
      ref={dialogRef}
      className={className}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      tabIndex={-1}
    >
      {children}
    </section>
  );

  if (!backdrop) return surface;

  return (
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
}
