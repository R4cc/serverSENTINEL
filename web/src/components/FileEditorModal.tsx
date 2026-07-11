import { Component, lazy, Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import { AppIcon } from "./FileTypeIcon";
import { InlineState } from "./InlineState";
import { Button } from "./UiPrimitives";
import { parentPath } from "../utils/files";

type FileEditorModalProps = {
  selectedPath: string;
  editorText: string;
  dirty: boolean;
  fileOpening: boolean;
  fileOpenFailed: boolean;
  fileReadError: string;
  fileSaving: boolean;
  editing: boolean;
  editBusy: boolean;
  editMessage: string;
  editDisabled: boolean;
  editDisabledReason?: string;
  readOnlyOnly?: boolean;
  editorDisabled: boolean;
  saveDisabled: boolean;
  discardRequestOpen: boolean;
  onTextChange: (text: string) => void;
  onRequestClose: () => void;
  onCancel: () => void;
  onSave: () => void;
  onEnterEdit: () => void;
  onRetryOpen: () => void;
  onKeepEditing: () => void;
  onDiscardChanges: () => void;
};

const CodeEditor = lazy(() => import("./CodeEditor"));

type EditorLoadBoundaryProps = {
  children: ReactNode;
};

type EditorLoadBoundaryState = {
  failed: boolean;
};

class EditorLoadBoundary extends Component<EditorLoadBoundaryProps, EditorLoadBoundaryState> {
  state: EditorLoadBoundaryState = { failed: false };

  static getDerivedStateFromError(): EditorLoadBoundaryState {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="fileEditorStateFill">
          <InlineState tone="error" title="Editor failed to load" message="Reload the page and try opening the file again." />
        </div>
      );
    }

    return this.props.children;
  }
}

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
  editing,
  editBusy,
  editMessage,
  editDisabled,
  editDisabledReason = "",
  readOnlyOnly = false,
  editorDisabled,
  saveDisabled,
  discardRequestOpen,
  onTextChange,
  onRequestClose,
  onCancel,
  onSave,
  onEnterEdit,
  onRetryOpen,
  onKeepEditing,
  onDiscardChanges
}: FileEditorModalProps) {
  const modalRef = useRef<HTMLElement>(null);
  const canCloseEditorRef = useRef(true);
  const onRequestCloseRef = useRef(onRequestClose);
  const editorFileName = useMemo(() => selectedPath.split("/").filter(Boolean).pop() ?? selectedPath, [selectedPath]);
  const editorFolderPath = useMemo(() => (selectedPath ? parentPath(selectedPath) : ""), [selectedPath]);
  const editorLocation = editorFolderPath || "Root directory";
  const canCloseEditor = !fileSaving;
  const saveDisabledReason = fileSaving
    ? "File save is already in progress."
    : fileOpenFailed
      ? "Retry opening the file before saving."
      : !editing
        ? "Enter edit mode before saving."
      : editorDisabled
        ? editDisabledReason || "This file is read-only."
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
                <p className="fileEditorLocation">{editorLocation}</p>
              </div>
              <Button iconOnly variant="secondary" className="iconButton modalCloseButton" onClick={onRequestClose} disabled={!canCloseEditor} aria-label="Close editor" title={canCloseEditor ? "Close editor" : "File save is still in progress"}>
                <AppIcon name="x" />
              </Button>
            </header>
            <div className="fileEditorBody">
              <div className="fileEditorMetaRow">
                <span className={`fileEditorMode ${editing ? "editing" : "readOnly"}`}>
                  <span className="fileEditorModeDot" aria-hidden="true" />
                  {editing ? "Editing" : "Read-only"}
                </span>
                <span className="fileEditorMetaDivider" aria-hidden="true" />
                <span className="fileEditorLineCount">{editorText.split("\n").length} lines</span>
                {dirty && <span className="dirty">Unsaved changes</span>}
                {!editing && editDisabled && editDisabledReason && <span className="fileEditorRestriction">{editDisabledReason}</span>}
              </div>
              {editMessage && (
                <div className="fileLeaseNotice" role="status">
                  <strong>Editing is unavailable</strong>
                  <span>{editMessage}</span>
                </div>
              )}
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
                      <EditorLoadBoundary key={selectedPath}>
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
                      </EditorLoadBoundary>
                    )}
                  </>
                )}
              </div>
            </div>
            <footer className="fileEditorFooter">
              <Button variant="secondary" onClick={onCancel} disabled={fileSaving} title={fileSaving ? "File save is still in progress" : "Close editor"}>Cancel</Button>
              {readOnlyOnly ? null : editing ? (
                <Button onClick={onSave} disabled={saveDisabled} title={saveDisabled ? saveDisabledReason || "Save is unavailable right now." : "Save file"} reserveLabel="Saving">
                  {fileSaving ? "Saving" : "Save"}
                </Button>
              ) : (
                <Button onClick={onEnterEdit} disabled={editDisabled || editBusy || fileOpening || fileOpenFailed} title={editDisabled ? editDisabledReason || "Edit permission is required." : "Acquire an exclusive edit lease"} reserveLabel="Requesting edit access">
                  {editBusy ? "Requesting edit access" : "Edit file"}
                </Button>
              )}
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
              <Button iconOnly variant="secondary" className="iconButton modalCloseButton" onClick={onKeepEditing} aria-label="Close discard dialog" title="Close dialog">
                <AppIcon name="x" />
              </Button>
            </header>
            <div className="modalBody">
              <p>Discard this editor session and lose the unsaved file changes?</p>
            </div>
            <footer className="modalFooter discardEditorActions">
              <Button variant="secondary" onClick={onKeepEditing}>Keep Editing</Button>
              <Button variant="critical" onClick={onDiscardChanges}>Discard Changes</Button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
