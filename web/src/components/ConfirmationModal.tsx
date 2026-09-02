import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AppIcon } from "./FileTypeIcon";
import { Banner, Button } from "./UiPrimitives";
import { DialogSurface } from "./DialogSurface";

export type ConfirmationOptions = {
  title: string;
  description: string;
  details?: ReactNode;
  warning?: string;
  warningTone?: "warning" | "danger";
  textInput?: {
    label: string;
    description?: string;
    placeholder?: string;
    required?: boolean;
    maxLength?: number;
    rows?: number;
  };
  confirmLabel: string;
  cancelLabel?: string;
  variant?: "primary" | "critical";
};

export type RequestConfirmation = (options: ConfirmationOptions) => Promise<boolean>;
export type RequestTextConfirmation = (options: ConfirmationOptions & { textInput: NonNullable<ConfirmationOptions["textInput"]> }) => Promise<string | null>;

type ConfirmationOutcome = {
  confirmed: boolean;
  textValue: string;
};

export function useConfirmationController() {
  const [options, setOptions] = useState<ConfirmationOptions | null>(null);
  const resolverRef = useRef<((outcome: ConfirmationOutcome) => void) | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const settle = useCallback((confirmed: boolean, textValue = "") => {
    const resolve = resolverRef.current;
    const trigger = triggerRef.current;
    resolverRef.current = null;
    triggerRef.current = null;
    setOptions(null);
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    resolve?.({ confirmed, textValue: textValue.trim() });
  }, []);

  const requestOutcome = useCallback((nextOptions: ConfirmationOptions) => {
    if (resolverRef.current) {
      resolverRef.current({ confirmed: false, textValue: "" });
    } else {
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setOptions(nextOptions);
    return new Promise<ConfirmationOutcome>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const requestConfirmation = useCallback<RequestConfirmation>(async (nextOptions) => (
    await requestOutcome(nextOptions)
  ).confirmed, [requestOutcome]);

  const requestTextConfirmation = useCallback<RequestTextConfirmation>(async (nextOptions) => {
    const outcome = await requestOutcome(nextOptions);
    return outcome.confirmed ? outcome.textValue : null;
  }, [requestOutcome]);

  useEffect(() => () => {
    resolverRef.current?.({ confirmed: false, textValue: "" });
    resolverRef.current = null;
  }, []);

  return { options, requestConfirmation, requestTextConfirmation, settle };
}

export function ConfirmationModal({
  options,
  onConfirm,
  onCancel
}: {
  options: ConfirmationOptions;
  onConfirm: (textValue?: string) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const warningId = useId();
  const textInputId = useId();
  const textInputDescriptionId = useId();
  const [textValue, setTextValue] = useState("");

  useEffect(() => setTextValue(""), [options]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onConfirm(textValue);
  }

  return (
    <DialogSurface backdrop="confirmationBackdrop" className="modalPanel confirmModalPanel confirmationModal" labelledBy={titleId} describedBy={`${descriptionId}${options.warning ? ` ${warningId}` : ""}`} onClose={onCancel}>
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
          {options.warning ? (
            <Banner
              id={warningId}
              tone={(options.warningTone ?? (options.variant === "primary" ? "warning" : "danger")) === "danger" ? "error" : "warning"}
              compact
              title={options.warning}
            />
          ) : null}
          {options.textInput ? (
            <label className="confirmationTextField" htmlFor={textInputId}>
              <span className="fieldLabel">{options.textInput.label}</span>
              <textarea
                id={textInputId}
                value={textValue}
                onChange={(event) => setTextValue(event.target.value)}
                placeholder={options.textInput.placeholder}
                required={options.textInput.required}
                maxLength={options.textInput.maxLength}
                rows={options.textInput.rows ?? 3}
                aria-describedby={options.textInput.description ? textInputDescriptionId : undefined}
              />
              {options.textInput.description ? <small id={textInputDescriptionId}>{options.textInput.description}</small> : null}
            </label>
          ) : null}
        </div>
        <footer className="modalFooter">
          <Button variant="secondary" onClick={onCancel}>{options.cancelLabel ?? "Cancel"}</Button>
          <Button variant={options.variant ?? "critical"} type="submit">{options.confirmLabel}</Button>
        </footer>
      </form>
    </DialogSurface>
  );
}
