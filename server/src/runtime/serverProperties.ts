/**
 * Splits one logical `.properties` line into key and value the way `java.util.Properties` does:
 * the key ends at the first unescaped `=`, `:`, or whitespace, and one `=` or `:` may follow
 * surrounding whitespace. Minecraft reads the file with `Properties.load`, so a hand-edited
 * `motd:Hello` or `motd Hello` is a real setting and has to be recognized here too.
 */
function propertyEntry(rawLine: string) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#") || line.startsWith("!")) return undefined;
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "\\") { index += 2; continue; }
    if (char === "=" || char === ":" || /\s/.test(char)) break;
    index += 1;
  }
  // A bare word with no separator is not a setting this panel reads or writes.
  if (index >= line.length) return undefined;
  const key = line.slice(0, index);
  let rest = line.slice(index).replace(/^\s+/, "");
  if (rest.startsWith("=") || rest.startsWith(":")) rest = rest.slice(1);
  return { key, value: rest.trim() };
}

export function parseServerProperties(text?: string) {
  const values: Record<string, string> = {};
  for (const rawLine of (text ?? "").split(/\r?\n/)) {
    const entry = propertyEntry(rawLine);
    if (entry) values[entry.key] = entry.value;
  }
  return values;
}

export function serializeServerProperties(values: Record<string, string>) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

/**
 * Applies `updates` to an existing file in place. Every line the update does not touch -- comments,
 * blank lines, settings in a separator style the panel would not write itself -- is kept as it was,
 * so saving one setting cannot silently delete another. Keys the file lacks are appended.
 */
export function updateServerPropertiesText(text: string | undefined, updates: Record<string, string>) {
  const source = text ?? "";
  if (!source) return serializeServerProperties(updates);
  const remaining = new Map(Object.entries(updates));
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const updated: string[] = [];
  for (const line of lines) {
    const entry = propertyEntry(line);
    if (entry && Object.hasOwn(updates, entry.key)) {
      // A repeated key collapses to a single line carrying the new value, at its first position.
      if (!remaining.has(entry.key)) continue;
      updated.push(`${entry.key}=${remaining.get(entry.key)}`);
      remaining.delete(entry.key);
      continue;
    }
    updated.push(line);
  }
  for (const [key, value] of remaining) updated.push(`${key}=${value}`);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return `${updated.join(newline)}${newline}`;
}
