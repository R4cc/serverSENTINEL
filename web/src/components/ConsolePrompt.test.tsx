import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConsolePrompt } from "./ConsolePrompt";

describe("ConsolePrompt", () => {
  it("announces why command input is unavailable", () => {
    const html = renderToStaticMarkup(
      <ConsolePrompt
        canSendCommands={false}
        disabledReason="Start the server to send commands."
        commandHistory={[]}
        fontSize={12}
        onCommand={vi.fn()}
      />
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Start the server to send commands.");
    expect(html).not.toContain("<input");
  });

  it("renders a named, console-sized command input when available", () => {
    const html = renderToStaticMarkup(
      <ConsolePrompt
        canSendCommands
        disabledReason=""
        commandHistory={[]}
        fontSize={14}
        onCommand={vi.fn()}
      />
    );

    expect(html).toContain('--console-prompt-font-size:14px');
    expect(html).toContain('aria-label="Console command"');
    expect(html).toContain('enterKeyHint="send"');
  });
});
