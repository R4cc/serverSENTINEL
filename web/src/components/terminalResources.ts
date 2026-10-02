let renderer: Promise<typeof import("@xterm/addon-webgl") | null> | undefined;
let fonts: Promise<unknown> | undefined;

/** Start the optional renderer alongside the terminal chunk, rather than after it mounts. */
export function loadTerminalRenderer() {
  return renderer ??= import("@xterm/addon-webgl").catch(() => {
    renderer = undefined;
    return null;
  });
}

/** Resolve regular and bold metrics before xterm measures cells or displays wrapped output. */
export function loadTerminalFonts() {
  if (fonts) return fonts;
  if (!document.fonts) return Promise.resolve();
  const family = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";
  return fonts ??= Promise.all([
    document.fonts.load(`400 14px ${family}`),
    document.fonts.load(`600 14px ${family}`)
  ]).catch(() => {
    // A missing font uses the browser fallback for this visit; leave future visits free to retry.
    fonts = undefined;
  });
}
