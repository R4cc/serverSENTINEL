import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AppIcon } from "./FileTypeIcon";
import { Banner, Button } from "./UiPrimitives";
import { DialogSurface } from "./DialogSurface";

export { useConfirmationController } from "./useConfirmationController";
export type { ConfirmationOptions, RequestConfirmation, RequestTextConfirmation } from "./useConfirmationController";
import type { ConfirmationOptions } from "./useConfirmationController";

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
  const textInputErrorId = useId();
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const [textValue, setTextValue] = useState("");
  const [textMissing, setTextMissing] = useState(false);

  useEffect(() => {
    setTextValue("");
    setTextMissing(false);
  }, [options]);

  // A required reason is checked here, not by the browser: its validation bubble is unstyled, sits
  // over the dialog's own text, and disappears again before it can be read.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (options.textInput?.required && !textValue.trim()) {
      setTextMissing(true);
      textInputRef.current?.focus();
      return;
    }
    onConfirm(textValue);
  }

  return (
    <DialogSurface backdrop="confirmationBackdrop" className="modalPanel confirmModalPanel confirmationModal" labelledBy={titleId} describedBy={`${descriptionId}${options.warning ? ` ${warningId}` : ""}`} onClose={onCancel}>
      <form onSubmit={submit} noValidate>
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
              <span className="fieldLabel">{options.textInput.label}{options.textInput.required ? <span className="confirmationRequired"> (required)</span> : null}</span>
              <textarea
                ref={textInputRef}
                id={textInputId}
                value={textValue}
                onChange={(event) => {
                  setTextValue(event.target.value);
                  if (event.target.value.trim()) setTextMissing(false);
                }}
                aria-invalid={textMissing || undefined}
                placeholder={options.textInput.placeholder}
                required={options.textInput.required}
                maxLength={options.textInput.maxLength}
                rows={options.textInput.rows ?? 3}
                aria-describedby={[textMissing ? textInputErrorId : "", options.textInput.description ? textInputDescriptionId : ""].filter(Boolean).join(" ") || undefined}
              />
              {textMissing ? <small id={textInputErrorId} className="confirmationFieldError" role="alert">Enter a reason to continue.</small> : null}
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
