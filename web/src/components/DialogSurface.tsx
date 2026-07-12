import type { ReactNode } from "react";
import { useDialogFocus } from "./useDialogFocus";

export function DialogSurface({
  className,
  labelledBy,
  describedBy,
  onClose,
  children
}: {
  className: string;
  labelledBy: string;
  describedBy?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useDialogFocus<HTMLElement>({ onClose });
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
