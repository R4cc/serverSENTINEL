/**
 * Which grammar a file gets, from its name alone. This lives apart from the editor so the editor's
 * frame can name the language without pulling the lazily loaded editor into the main bundle.
 */
export type EditorLanguageKind =
  | "json"
  | "yaml"
  | "javascript"
  | "markdown"
  | "toml"
  | "properties"
  | "shell"
  | "plain";

const languageLabels: Record<EditorLanguageKind, string> = {
  json: "JSON",
  yaml: "YAML",
  javascript: "JavaScript",
  markdown: "Markdown",
  toml: "TOML",
  properties: "Properties",
  shell: "Shell",
  plain: "Plain text"
};

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

export function editorLanguageLabel(path: string) {
  return languageLabels[editorLanguageKind(path)];
}
