import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConsoleChat } from "./ConsoleChat";

function line(text: string) {
  return `${text}\n`;
}

const transcript = [
  line("[12:00:00] [Server thread/INFO]: Notch joined the game"),
  line("[12:00:10] [Server thread/INFO]: <Notch> hey everyone"),
  line("[12:00:20] [Server thread/INFO]: <Notch> anyone near spawn?"),
  line("[12:00:30] [Server thread/INFO]: <Steve> on my way"),
  line("[12:00:40] [Server thread/INFO]: [Server] server restarts at 03:00"),
  line("[12:00:50] [Server thread/INFO]: Preparing spawn area: 12%")
];

function render(overrides: Partial<Parameters<typeof ConsoleChat>[0]> = {}) {
  return renderToStaticMarkup(
    <ConsoleChat
      entries={transcript}
      serverId="server-1"
      playerHeadsEnabled
      canSendCommands
      disabledReason=""
      onCommand={() => undefined}
      {...overrides}
    />
  );
}

describe("ConsoleChat", () => {
  it("renders player messages, system notices, and server broadcasts", () => {
    const html = render();

    expect(html).toContain("hey everyone");
    expect(html).toContain("on my way");
    expect(html).toContain("Notch joined the game");
    expect(html).toContain("server restarts at 03:00");
    expect(html).not.toContain("Preparing spawn area");
  });

  it("stacks consecutive messages from one author under a single avatar", () => {
    const html = render();

    expect(html.match(/consoleChatCluster tone-/g)).toHaveLength(3);
    expect(html.match(/consoleChatBubble/g)).toHaveLength(4);
    // One avatar per stack rather than one per message.
    expect(html.match(/consoleChatAvatar["\s]/g)).toHaveLength(3);
  });

  it("uses player heads when the integration is enabled", () => {
    const html = render();

    expect(html).toContain("/api/servers/server-1/player-head/Notch");
    expect(html).not.toContain("consoleChatAvatarPlaceholder");
  });

  it("falls back to initials when player heads are disabled", () => {
    const html = render({ playerHeadsEnabled: false });

    expect(html).not.toContain("player-head");
    expect(html).toContain("consoleChatAvatarPlaceholder");
    expect(html).toContain(">NO<");
    expect(html).toContain(">ST<");
  });

  it("explains why the composer is unavailable without command permission", () => {
    const html = render({ canSendCommands: false, disabledReason: "Start the server to send commands." });

    expect(html).toContain("Start the server to send commands.");
    expect(html).toContain("disabled");
  });

  it("invites the operator to broadcast or run a command", () => {
    expect(render()).toContain("Message the server, or start with / to run a command");
  });

  it("shows an empty state when the console holds no conversation", () => {
    const html = render({ entries: [line("[12:00:00] [Server thread/INFO]: Done (5.1s)! For help, type \"help\"")] });

    expect(html).toContain("No chat yet");
    expect(html).not.toContain("consoleChatCluster");
  });
});
