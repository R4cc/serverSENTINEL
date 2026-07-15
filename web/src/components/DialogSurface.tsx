import type { ReactNode } from "react";
import { useDialogFocus } from "./useDialogFocus";

export function DialogSurface({
  className,
  labelledBy,
  describedBy,
  onClose,
  allowDocumentScrollOnPhone = false,
  children
}: {
  className: string;
  labelledBy: string;
  describedBy?: string;
  onClose: () => void;
  allowDocumentScrollOnPhone?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useDialogFocus<HTMLElement>({ onClose, allowDocumentScrollOnPhone });
  return (
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
}
