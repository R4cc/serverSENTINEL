import { useEffect, useMemo, useRef } from "react";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, StreamLanguage } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { toml } from "@codemirror/legacy-modes/mode/toml";

type CodeEditorProps = {
  selectedPath: string;
  fileName: string;
  value: string;
  disabled: boolean;
  saveDisabled: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
};

function editorLanguage(path: string): Extension {
  const fileName = path.split("/").pop()?.toLowerCase() ?? "";
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";

  if (extension === "json" || extension === "json5") return json();
  if (extension === "yml" || extension === "yaml") return yaml();
  if (extension === "md" || extension === "markdown") return markdown();
  if (extension === "toml") return StreamLanguage.define(toml);
  if (["properties", "cfg", "conf", "env"].includes(extension) || fileName === ".env") return StreamLanguage.define(properties);
  return [];
}

const serverSentinelEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    minHeight: "0",
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: "13px"
  },
  "&.cm-focused": {
    outline: "2px solid var(--accent)",
    outlineOffset: "-2px"
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-mono)",
    lineHeight: "20px"
  },
  ".cm-content": {
    minHeight: "100%",
    caretColor: "var(--text)",
    padding: "var(--space-3) 0",
    lineHeight: "20px"
  },
  ".cm-line": {
    padding: "0 var(--space-3)",
    lineHeight: "20px"
  },
  ".cm-gutters": {
    borderRight: "var(--border-strong) solid var(--border)",
    backgroundColor: "var(--surface-muted)",
    color: "var(--text-soft)",
    lineHeight: "20px"
  },
  ".cm-gutterElement": {
    lineHeight: "20px"
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "44px",
    padding: "0 var(--space-2)",
    fontSize: "12px",
    fontWeight: "800"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--sentinel-accent-soft)",
    color: "var(--accent)"
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)"
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)"
  },
  ".cm-cursor": {
    borderLeftColor: "var(--text)"
  },
  ".cm-foldGutter .cm-gutterElement": {
    cursor: "pointer"
  }
});

export default function CodeEditor({
  selectedPath,
  fileName,
  value,
  disabled,
  saveDisabled,
  onChange,
  onSave
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const saveDisabledRef = useRef(saveDisabled);
  const language = useMemo(() => editorLanguage(selectedPath), [selectedPath]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    saveDisabledRef.current = saveDisabled;
  }, [saveDisabled]);

  useEffect(() => {
    if (!hostRef.current) return;

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          rectangularSelection(),
          highlightActiveLine(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          serverSentinelEditorTheme,
          language,
          EditorState.readOnly.of(disabled),
          EditorView.editable.of(!disabled),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                if (!saveDisabledRef.current) onSaveRef.current();
                return true;
              }
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          })
        ]
      })
    });

    viewRef.current = view;
    const measureFrame = window.requestAnimationFrame(() => {
      view.requestMeasure();
      view.focus();
    });
    const resizeObserver = new ResizeObserver(() => view.requestMeasure());
    resizeObserver.observe(hostRef.current);
    void document.fonts?.ready.then(() => {
      if (viewRef.current === view) view.requestMeasure();
    });

    return () => {
      window.cancelAnimationFrame(measureFrame);
      resizeObserver.disconnect();
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [disabled, language, selectedPath]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value }
    });
  }, [value]);

  return <div ref={hostRef} className="fileCodeEditor" aria-label={`Edit ${fileName}`} />;
}
