import { useCallback, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { search } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
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

type EditorLanguageKind =
  | "json"
  | "yaml"
  | "javascript"
  | "markdown"
  | "toml"
  | "properties"
  | "shell"
  | "plain";

const serverSentinelHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "var(--editor-comment)" },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--editor-keyword)" },
  { tag: [tags.propertyName, tags.variableName, tags.definition(tags.variableName), tags.attributeName], color: "var(--editor-property)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--editor-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--editor-constant)" },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: "var(--editor-punctuation)" },
  { tag: [tags.heading, tags.strong], color: "var(--editor-heading)", fontWeight: "700" },
  { tag: tags.link, color: "var(--editor-link)", textDecoration: "underline" }
]);

export const editorSearchExtension = search();

const editableBasicSetup = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  bracketMatching: true,
  closeBrackets: true,
  history: true,
  drawSelection: true,
  dropCursor: true,
  highlightSpecialChars: true,
  rectangularSelection: true,
  syntaxHighlighting: false
} as const;

const readOnlyBasicSetup = {
  ...editableBasicSetup,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  bracketMatching: false,
  closeBrackets: false,
  history: false,
  dropCursor: false,
  rectangularSelection: false
} as const;

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
  },
  "&.cm-editor[aria-readonly='true']": {
    backgroundColor: "var(--surface-muted)",
    cursor: "text"
  },
  "&.cm-editor[aria-readonly='true'] .cm-content": {
    caretColor: "transparent"
  },
  "&.cm-editor[aria-readonly='true'].cm-focused": {
    outline: "1px solid var(--border-panel)"
  },
  "&.cm-editor[aria-readonly='true'] .cm-activeLine": {
    backgroundColor: "transparent"
  },
  "&.cm-editor[aria-readonly='true'] .cm-activeLineGutter": {
    backgroundColor: "var(--surface-muted)",
    color: "var(--text-soft)"
  }
});

const propertiesLanguage = StreamLanguage.define(properties);
const shellLanguage = StreamLanguage.define(shell);
const tomlLanguage = StreamLanguage.define(toml);

function fileParts(path: string) {
  const fileName = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  return { fileName, extension };
}

export function editorLanguageKind(path: string): EditorLanguageKind {
  const { fileName, extension } = fileParts(path);

  if (extension === "json" || extension === "json5" || fileName === "pack.mcmeta") return "json";
  if (extension === "yml" || extension === "yaml") return "yaml";
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"].includes(extension)) return "javascript";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "toml") return "toml";
  if (
    ["properties", "cfg", "conf", "cnf", "env", "ini", "prefs"].includes(extension) ||
    fileName === ".env" ||
    fileName.endsWith(".env.local")
  ) {
    return "properties";
  }
  if (["sh", "bash", "zsh", "fish", "command", "bat", "cmd", "ps1"].includes(extension)) return "shell";
  return "plain";
}

function editorLanguage(path: string): Extension {
  switch (editorLanguageKind(path)) {
    case "json":
      return json();
    case "yaml":
      return yaml();
    case "javascript":
      return javascript({ typescript: true, jsx: true });
    case "markdown":
      return markdown();
    case "toml":
      return tomlLanguage;
    case "properties":
      return propertiesLanguage;
    case "shell":
      return shellLanguage;
    case "plain":
      return [];
  }
}

export default function CodeEditor({
  selectedPath,
  fileName,
  value,
  disabled,
  saveDisabled,
  onChange,
  onSave
}: CodeEditorProps) {
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const saveDisabledRef = useRef(saveDisabled);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  saveDisabledRef.current = saveDisabled;

  const handleChange = useCallback((nextValue: string) => {
    onChangeRef.current(nextValue);
  }, []);

  const extensions = useMemo<Extension[]>(
    () => [
      syntaxHighlighting(serverSentinelHighlightStyle, { fallback: true }),
      editorLanguage(selectedPath),
      editorSearchExtension,
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            if (!saveDisabledRef.current) onSaveRef.current();
            return true;
          }
        }
      ])
    ],
    [selectedPath]
  );

  return (
    <CodeMirror
      aria-label={`Edit ${fileName}`}
      autoFocus
      basicSetup={disabled ? readOnlyBasicSetup : editableBasicSetup}
      className={`fileCodeEditor${disabled ? " fileCodeEditor-disabled" : ""}`}
      editable={!disabled}
      extensions={extensions}
      height="100%"
      indentWithTab
      minHeight="100%"
      onChange={handleChange}
      readOnly={disabled}
      theme={serverSentinelEditorTheme}
      value={value}
    />
  );
}
