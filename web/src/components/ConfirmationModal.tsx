import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AppIcon } from "./FileTypeIcon";
import { Button } from "./UiPrimitives";
import { useDialogFocus } from "./useDialogFocus";

export type ConfirmationOptions = {
  title: string;
  description: string;
  details?: ReactNode;
  warning?: string;
  warningTone?: "warning" | "danger";
  confirmLabel: string;
  cancelLabel?: string;
  variant?: "primary" | "critical";
};

export type RequestConfirmation = (options: ConfirmationOptions) => Promise<boolean>;

export function useConfirmationController() {
  const [options, setOptions] = useState<ConfirmationOptions | null>(null);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolverRef.current;
    const trigger = triggerRef.current;
    resolverRef.current = null;
    triggerRef.current = null;
    setOptions(null);
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    resolve?.(confirmed);
  }, []);

  const requestConfirmation = useCallback<RequestConfirmation>((nextOptions) => {
    if (resolverRef.current) {
      resolverRef.current(false);
    } else {
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setOptions(nextOptions);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  useEffect(() => () => {
    resolverRef.current?.(false);
    resolverRef.current = null;
  }, []);

  return { options, requestConfirmation, settle };
}

export function ConfirmationModal({
  options,
  onConfirm,
  onCancel
}: {
  options: ConfirmationOptions;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const modalRef = useDialogFocus<HTMLElement>({ onClose: onCancel });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onConfirm();
  }

  return (
    <div className="modalBackdrop confirmationBackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section className="modalPanel confirmModalPanel confirmationModal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} ref={modalRef}>
        <form onSubmit={submit}>
          <header className="modalHeader">
            <h2 id={titleId}>{options.title}</h2>
            <Button variant="secondary" iconOnly className="iconButton modalCloseButton" onClick={onCancel} aria-label="Close confirmation dialog" title="Close dialog">
              <AppIcon name="x" />
            </Button>
          </header>
          <div className="modalBody confirmContent">
            <p id={descriptionId}>{options.description}</p>
            {options.details ? <blockquote>{options.details}</blockquote> : null}
            {options.warning ? <p className={`confirmationWarning confirmationWarning--${options.warningTone ?? (options.variant === "primary" ? "warning" : "danger")}`}>{options.warning}</p> : null}
          </div>
          <footer className="modalFooter">
            <Button variant="secondary" onClick={onCancel}>{options.cancelLabel ?? "Cancel"}</Button>
            <Button variant={options.variant ?? "critical"} type="submit">{options.confirmLabel}</Button>
          </footer>
        </form>
      </section>
    </div>
  );
}
