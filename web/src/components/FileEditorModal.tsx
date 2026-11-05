import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EditorCursor } from "./CodeEditor";
import { editorLanguageLabel } from "./editorLanguage";
import { AppIcon } from "./FileTypeIcon";
import { InlineState } from "./InlineState";
import { Button } from "./UiPrimitives";
import { parentPath } from "../utils/files";
import { DialogSurface } from "./DialogSurface";
import { CodeLoadingSkeleton } from "./LoadingSkeletons";

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
  editorDisabled: boolean;
  saveDisabled: boolean;
  discardRequestOpen: boolean;
  onTextChange: (text: string) => void;
  onRequestClose: () => void;
  onCancel: () => void;
  onSave: () => void;
  onCopy: () => void;
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
      <CodeLoadingSkeleton label="Preparing code editor" />
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
  editorDisabled,
  saveDisabled,
  discardRequestOpen,
  onTextChange,
  onRequestClose,
  onCancel,
  onSave,
  onCopy,
  onEnterEdit,
  onRetryOpen,
  onKeepEditing,
  onDiscardChanges
}: FileEditorModalProps) {
  const editorFileName = useMemo(() => selectedPath.split("/").filter(Boolean).pop() ?? selectedPath, [selectedPath]);
  const editorFolderPath = useMemo(() => (selectedPath ? parentPath(selectedPath) : ""), [selectedPath]);
  const editorLocation = editorFolderPath || "Root directory";
  const editorLanguage = useMemo(() => editorLanguageLabel(selectedPath), [selectedPath]);
  const [cursor, setCursor] = useState<EditorCursor>({ line: 1, column: 1 });
  useEffect(() => setCursor({ line: 1, column: 1 }), [selectedPath]);
  // "Read-only" is kept for a file that cannot be edited here; one that can is only being viewed.
  const modeLabel = editing ? "Editing" : editDisabled ? "Read-only" : "Viewing";
  const canCloseEditor = !fileSaving;
  const editingRestriction = !editing ? editMessage || (editDisabled ? editDisabledReason : "") : "";
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

  if (!selectedPath && !discardRequestOpen) return null;

  return (
    <>
      {selectedPath && (
        <DialogSurface mobileFullscreen backdrop="fileEditorBackdrop" dismissible={canCloseEditor} className="modalPanel fileEditorModal" labelledBy="file-editor-title" onClose={onRequestClose}>
          <header className="fileEditorHeader">
            <div>
              <h2 id="file-editor-title">{editorFileName}</h2>
              <p className="fileEditorLocation">{editorLocation}</p>
            </div>
            <Button iconOnly variant="secondary" className="iconButton modalCloseButton" onClick={onRequestClose} disabled={!canCloseEditor} aria-label="Close editor" title={canCloseEditor ? "Close editor" : "File save is still in progress"}>
              <AppIcon name="x" />
            </Button>
          </header>
          <div className="fileEditorBody">
            <div className="fileEditorMetaRow">
              <span className={`fileEditorMode ${editing ? "editing" : "readOnly"}${editingRestriction ? " unavailable" : ""}`} title={editingRestriction || undefined}>
                <span className="fileEditorModeDot" aria-hidden="true" />
                {modeLabel}
              </span>
              {dirty && <><span className="fileEditorMetaDivider" aria-hidden="true" /><span className="dirty">Unsaved changes</span></>}
              <div className="fileEditorMetaActions">
                <span className="fileEditorPosition" aria-label={`Line ${cursor.line}, column ${cursor.column} of ${editorText.split("\n").length} lines`}>
                  Ln {cursor.line}, Col {cursor.column}
                  <span className="fileEditorPositionTotal"> · {editorText.split("\n").length} lines</span>
                </span>
                <span className="fileEditorMetaDivider" aria-hidden="true" />
                <span className="fileEditorLanguage">{editorLanguage}</span>
                {editingRestriction && (
                  <span className="fileEditorRestriction" role="status" title={editingRestriction} aria-label={`Editing unavailable: ${editingRestriction}`}>
                    Editing unavailable
                  </span>
                )}
                <Button iconOnly compact variant="ghost" className="fileEditorCopyButton" onClick={onCopy} aria-label="Copy entire file" title="Copy entire file">
                  <AppIcon name="copy" />
                </Button>
              </div>
            </div>
            {editingRestriction && <p className="fileEditorRestrictionReason" role="status">{editingRestriction}</p>}
            <div className={`fileEditorMainArea${fileReadError && !fileOpenFailed ? " hasReadError" : ""}`}>
              {fileOpening ? (
                <div className="fileEditorStateFill">
                  <CodeLoadingSkeleton label="Opening file" />
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
                          onCursorChange={setCursor}
                        />
                      </Suspense>
                    </EditorLoadBoundary>
                  )}
                </>
              )}
            </div>
          </div>
          <footer className="fileEditorFooter">
            <Button variant="secondary" onClick={onCancel} disabled={fileSaving} title={fileSaving ? "File save is still in progress" : "Close editor"}>{editing ? "Cancel" : "Close"}</Button>
            {editing ? (
              <Button onClick={onSave} disabled={saveDisabled} title={saveDisabled ? saveDisabledReason || "Save is unavailable right now." : "Save file"} reserveLabel="Saving">
                {fileSaving ? "Saving" : "Save"}
              </Button>
            ) : (
              <Button onClick={onEnterEdit} disabled={editDisabled || editBusy || fileOpening || fileOpenFailed} title={editDisabled ? editDisabledReason || "Edit permission is required." : "Acquire an exclusive edit lease"} reserveLabel="Requesting…">
                {/* The button keeps room for its longest label; a long one made "Edit file" much wider
                    than Close, and wider than the Save that replaces it. */}
                {editBusy ? "Requesting…" : "Edit file"}
              </Button>
            )}
          </footer>
        </DialogSurface>
      )}

      {discardRequestOpen && (
        <DialogSurface backdrop="discardEditorBackdrop" className="modalPanel discardEditorModal" labelledBy="discard-editor-title" onClose={onKeepEditing}>
          <header className="modalHeader">
            <h2 id="discard-editor-title">Discard unsaved changes?</h2>
            <Button iconOnly variant="secondary" className="iconButton modalCloseButton" onClick={onKeepEditing} aria-label="Close discard dialog" title="Close dialog">
              <AppIcon name="x" />
            </Button>
          </header>
          <div className="modalBody">
            <p>{selectedPath ? <>Your edits to <strong>{editorFileName}</strong> have not been saved and will be lost.</> : "Your edits have not been saved and will be lost."}</p>
          </div>
          <footer className="modalFooter discardEditorActions">
            <Button variant="secondary" onClick={onKeepEditing}>Keep editing</Button>
            <Button variant="critical" onClick={onDiscardChanges}>Discard changes</Button>
          </footer>
        </DialogSurface>
      )}
    </>
  );
}
