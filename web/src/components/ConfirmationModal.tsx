import { useEffect, useId, useState, type FormEvent } from "react";
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
