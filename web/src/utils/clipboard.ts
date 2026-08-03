type FocusTarget = { focus?: (options?: { preventScroll?: boolean }) => void };

/**
 * The narrow surface copying needs from a window, so it stays callable from the node test
 * environment the rest of the web suite runs in.
 */
export interface ClipboardHost {
  isSecureContext: boolean;
  navigator: { clipboard?: { writeText(text: string): Promise<void> } };
  document: Pick<Document, "createElement" | "body" | "execCommand" | "activeElement">;
}

/**
 * Copies text, without assuming the panel is served from a secure context.
 *
 * A self-hosted panel is commonly reached over plain HTTP on a LAN, and there the whole
 * `navigator.clipboard` API is absent rather than merely restricted — so the carrier below is not a
 * fallback for exotic browsers, it is the path that runs on those deployments.
 */
export async function copyToClipboard(text: string, host: ClipboardHost = window): Promise<boolean> {
  if (!text) return false;
  try {
    if (host.isSecureContext && host.navigator.clipboard) {
      await host.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // A refused permission still leaves the carrier, which asks the browser for the same copy
    // through the path a user-driven Ctrl+C already grants.
  }
  return copyThroughCarrier(text, host);
}

function copyThroughCarrier(text: string, host: ClipboardHost) {
  let carrier: HTMLTextAreaElement | undefined;
  // Selecting the carrier takes focus. Copying from the console must not cost the command line its
  // caret, so whatever was focused gets it back.
  // `activeElement` is an Element, which is not necessarily focusable — only the ones that are
  // carry the method, so ask for it rather than assert it.
  const focused = host.document.activeElement as FocusTarget | null;
  try {
    carrier = host.document.createElement("textarea");
    carrier.value = text;
    carrier.readOnly = true;
    // Positioned off screen rather than hidden: an element that is not rendered cannot hold a
    // selection, and the copy then silently succeeds with nothing in it.
    carrier.style.position = "fixed";
    carrier.style.top = "-1000px";
    carrier.style.opacity = "0";
    host.document.body.appendChild(carrier);
    carrier.select();
    // iOS ignores select() on a read-only field and copies nothing without an explicit range.
    carrier.setSelectionRange(0, text.length);
    return host.document.execCommand("copy");
  } catch {
    return false;
  } finally {
    carrier?.remove();
    focused?.focus?.({ preventScroll: true });
  }
}
