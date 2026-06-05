import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
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

const CodeEditor = lazy(() => import("./CodeEditor"));

function EditorLoadingState() {
  return (
    <div className="fileEditorStateFill">
      <InlineState tone="loading" title="Preparing editor" message="Loading the code editor." />
    </div>
  );
}

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
  const canCloseEditorRef = useRef(true);
  const onRequestCloseRef = useRef(onRequestClose);
  const editorFileName = useMemo(() => selectedPath.split("/").filter(Boolean).pop() ?? selectedPath, [selectedPath]);
  const editorFolderPath = useMemo(() => (selectedPath ? parentPath(selectedPath) : ""), [selectedPath]);
  const canCloseEditor = !fileSaving;
  const saveDisabledReason = fileSaving
    ? "File save is already in progress."
    : fileOpenFailed
      ? "Retry opening the file before saving."
      : editorDisabled
        ? "This file is read-only."
        : !dirty
          ? "There are no changes to save."
          : "";

  useEffect(() => {
    canCloseEditorRef.current = canCloseEditor;
  }, [canCloseEditor]);

  useEffect(() => {
    onRequestCloseRef.current = onRequestClose;
  }, [onRequestClose]);

  useEffect(() => {
    if (!selectedPath || discardRequestOpen) return;
    modalRef.current?.focus();
  }, [discardRequestOpen, selectedPath]);

  useEffect(() => {
    if (!selectedPath || discardRequestOpen) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (canCloseEditorRef.current) onRequestCloseRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [discardRequestOpen, selectedPath]);

  if (!selectedPath && !discardRequestOpen) return null;

  return (
    <>
      {selectedPath && (
        <div className="modalBackdrop fileEditorBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && canCloseEditor) onRequestClose();
        }}>
          <section className="modalPanel fileEditorModal" role="dialog" aria-modal="true" aria-labelledby="file-editor-title" tabIndex={-1} ref={modalRef}>
            <header className="fileEditorHeader">
              <div>
                <h2 id="file-editor-title">{dirty ? `${editorFileName} *` : editorFileName}</h2>
                <p>{editorFolderPath || "/"}</p>
              </div>
              <button type="button" className="iconButton modalCloseButton" onClick={onRequestClose} disabled={!canCloseEditor} aria-label="Close editor" title={canCloseEditor ? "Close editor" : "File save is still in progress"}>
                <AppIcon name="x" />
              </button>
            </header>
            <div className="fileEditorBody">
              <div className="fileEditorMetaRow">
                <span>{editorDisabled ? "Read only" : "Editable"}</span>
                <span>{editorText.split("\n").length} lines</span>
                {dirty && <span className="dirty">Unsaved changes</span>}
              </div>
              <div className="fileEditorMainArea">
                {fileOpening ? (
                  <div className="fileEditorStateFill">
                    <InlineState tone="loading" title="Opening file" message="Loading this file in the editor." />
                  </div>
                ) : (
                  <>
                    {fileReadError && (
                      <div className={fileOpenFailed ? "fileEditorStateFill" : ""}>
                        <InlineState
                          tone="error"
                          title="Could not open this file"
                          message={`${fileReadError} Close the editor or retry if the file should still be available.`}
                          actionLabel={fileOpenFailed ? "Retry" : undefined}
                          onAction={fileOpenFailed ? onRetryOpen : undefined}
                        />
                      </div>
                    )}
                    {!fileOpenFailed && (
                      <Suspense fallback={<EditorLoadingState />}>
                        <CodeEditor
                          selectedPath={selectedPath}
                          fileName={editorFileName}
                          value={editorText}
                          disabled={editorDisabled}
                          saveDisabled={saveDisabled}
                          onChange={onTextChange}
                          onSave={onSave}
                        />
                      </Suspense>
                    )}
                  </>
                )}
              </div>
            </div>
            <footer className="fileEditorFooter">
              <button type="button" className="secondaryButton" onClick={onCancel} disabled={fileSaving} title={fileSaving ? "File save is still in progress" : "Close editor"}>Cancel</button>
              <button type="button" onClick={onSave} disabled={saveDisabled} title={saveDisabled ? saveDisabledReason || "Save is unavailable right now." : "Save file"}>
                {fileSaving ? "Saving" : "Save"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {discardRequestOpen && (
        <div className="modalBackdrop discardEditorBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onKeepEditing();
        }}>
          <section className="modalPanel discardEditorModal" role="dialog" aria-modal="true" aria-labelledby="discard-editor-title">
            <header className="modalHeader">
              <h2 id="discard-editor-title">Discard unsaved changes?</h2>
              <button type="button" className="iconButton modalCloseButton" onClick={onKeepEditing} aria-label="Close discard dialog" title="Close dialog">
                <AppIcon name="x" />
              </button>
            </header>
            <div className="modalBody">
              <p>Discard this editor session and lose the unsaved file changes?</p>
            </div>
            <footer className="modalFooter discardEditorActions">
              <button type="button" className="secondaryButton" onClick={onKeepEditing}>Keep Editing</button>
              <button type="button" className="dangerButton" onClick={onDiscardChanges}>Discard Changes</button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
