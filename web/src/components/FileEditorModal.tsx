import { useEffect, useMemo, useRef } from "react";
import { AppIcon } from "./FileTypeIcon";
import { InlineState } from "./InlineState";
import { parentPath } from "../utils/files";

type FileEditorModalProps = {
  selectedPath: string;
  editorText: string;
  dirty: boolean;
  fileOpening: boolean;
  fileOpenFailed: boolean;
  fileReadError: string;
  fileSaving: boolean;
  editorDisabled: boolean;
  saveDisabled: boolean;
  discardRequestOpen: boolean;
  onTextChange: (text: string) => void;
  onRequestClose: () => void;
  onCancel: () => void;
  onSave: () => void;
  onRetryOpen: () => void;
  onKeepEditing: () => void;
  onDiscardChanges: () => void;
};

export function FileEditorModal({
  selectedPath,
  editorText,
  dirty,
  fileOpening,
  fileOpenFailed,
  fileReadError,
  fileSaving,
  editorDisabled,
  saveDisabled,
  discardRequestOpen,
  onTextChange,
  onRequestClose,
  onCancel,
  onSave,
  onRetryOpen,
  onKeepEditing,
  onDiscardChanges
}: FileEditorModalProps) {
  const modalRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorFileName = useMemo(() => selectedPath.split("/").filter(Boolean).pop() ?? selectedPath, [selectedPath]);
  const editorFolderPath = useMemo(() => (selectedPath ? parentPath(selectedPath) : ""), [selectedPath]);

  useEffect(() => {
    if (!selectedPath || discardRequestOpen) return;
    modalRef.current?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onRequestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [discardRequestOpen, onRequestClose, selectedPath]);

  useEffect(() => {
    if (!selectedPath || fileOpening || fileOpenFailed) return;
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [fileOpenFailed, fileOpening, selectedPath]);

  if (!selectedPath && !discardRequestOpen) return null;

  return (
    <>
      {selectedPath && (
        <div className="modalBackdrop fileEditorBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onRequestClose();
        }}>
          <section className="modalPanel fileEditorModal" role="dialog" aria-modal="true" aria-labelledby="file-editor-title" tabIndex={-1} ref={modalRef}>
            <header className="fileEditorHeader">
              <div>
                <h2 id="file-editor-title">{dirty ? `${editorFileName} *` : editorFileName}</h2>
                <p>{editorFolderPath || "/"}</p>
              </div>
              <button type="button" className="iconButton modalCloseButton" onClick={onRequestClose} aria-label="Close editor" title="Close editor">
                <AppIcon name="x" />
              </button>
            </header>
            <div className="fileEditorBody">
              {fileOpening ? (
                <InlineState tone="loading" title="Opening file" message="Loading the editable file contents." />
              ) : (
                <>
                  {fileReadError && (
                    <InlineState
                      tone="error"
                      title="Editor error"
                      message={fileReadError}
                      actionLabel={fileOpenFailed ? "Retry" : undefined}
                      onAction={fileOpenFailed ? onRetryOpen : undefined}
                    />
                  )}
                  <textarea
                    ref={textareaRef}
                    className="fileEditorTextarea"
                    value={editorText}
                    onChange={(event) => onTextChange(event.target.value)}
                    disabled={editorDisabled}
                    spellCheck={false}
                  />
                </>
              )}
            </div>
            <footer className="fileEditorFooter">
              <button type="button" className="secondaryButton" onClick={onCancel} disabled={fileSaving}>Cancel</button>
              <button type="button" onClick={onSave} disabled={saveDisabled}>
                {fileSaving ? "Saving" : "Save"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {discardRequestOpen && (
        <div className="modalBackdrop discardEditorBackdrop" role="presentation">
          <section className="modalPanel discardEditorModal" role="dialog" aria-modal="true" aria-labelledby="discard-editor-title">
            <header className="panelHeader">
              <h2 id="discard-editor-title">Discard unsaved changes?</h2>
            </header>
            <p>Discard unsaved changes?</p>
            <div className="buttonRow discardEditorActions">
              <button type="button" className="secondaryButton" onClick={onKeepEditing}>Keep Editing</button>
              <button type="button" className="dangerButton" onClick={onDiscardChanges}>Discard Changes</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
