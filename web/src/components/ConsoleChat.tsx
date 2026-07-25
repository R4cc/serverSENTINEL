import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  ConsoleChatStream,
  consoleChatCommand,
  consoleChatHistoryLimit,
  consoleChatInitials,
  consoleChatTimeline,
  consoleChatTone,
  type ConsoleChatEntry
} from "../utils/consoleChat";
import { playerHeadSource } from "../utils/playerHeads";
import { Button, EmptyState } from "./UiPrimitives";

type ConsoleChatProps = {
  entries: string[];
  serverId: string;
  playerHeadsEnabled: boolean;
  canSendCommands: boolean;
  disabledReason: string;
  onCommand(command: string): void;
};

const stickyThresholdPixels = 64;

export function ConsoleChat({
  entries,
  serverId,
  playerHeadsEnabled,
  canSendCommands,
  disabledReason,
  onCommand
}: ConsoleChatProps) {
  const streamRef = useRef<ConsoleChatStream | null>(null);
  if (!streamRef.current) streamRef.current = new ConsoleChatStream();
  const [messages, setMessages] = useState<ConsoleChatEntry[]>(
    () => streamRef.current!.writeAll(entries).slice(-consoleChatHistoryLimit)
  );
  const previousEntriesRef = useRef(entries);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pinnedToLatest, setPinnedToLatest] = useState(true);
  const [draft, setDraft] = useState("");
  // Player heads are cached server side; refresh the URL hourly so skin changes appear.
  const headVersion = Math.floor(Date.now() / (60 * 60 * 1000));

  useEffect(() => {
    const previous = previousEntriesRef.current;
    previousEntriesRef.current = entries;
    if (previous === entries) return;

    const appendOnly = previous.length <= entries.length && previous.every((entry, index) => entry === entries[index]);
    if (appendOnly) {
      const added = entries.slice(previous.length);
      if (!added.length) return;
      const produced = streamRef.current!.writeAll(added);
      if (produced.length) setMessages((current) => [...current, ...produced].slice(-consoleChatHistoryLimit));
      return;
    }

    streamRef.current!.reset();
    setMessages(streamRef.current!.writeAll(entries).slice(-consoleChatHistoryLimit));
  }, [entries]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "auto") => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
  }, []);

  useLayoutEffect(() => {
    if (pinnedToLatest) scrollToLatest();
  }, [messages, pinnedToLatest, scrollToLatest]);

  const handleScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    setPinnedToLatest(distanceFromBottom <= stickyThresholdPixels);
  }, []);

  function submitDraft(event: FormEvent) {
    event.preventDefault();
    if (!canSendCommands) return;
    const command = consoleChatCommand(draft);
    if (!command) return;
    setDraft("");
    setPinnedToLatest(true);
    onCommand(command);
  }

  const timeline = consoleChatTimeline(messages);

  return (
    <div className="consoleChat">
      <div
        ref={scrollRef}
        className="consoleChatScroll"
        onScroll={handleScroll}
        role="log"
        aria-label="Server chat"
        aria-live="polite"
      >
        {timeline.length === 0 ? (
          <EmptyState
            className="consoleChatEmpty"
            title="No chat yet"
            message="Player messages, joins, and server broadcasts from the console appear here as a conversation."
          />
        ) : (
          <div className="consoleChatThread">
            {timeline.map((item) => {
              if (item.type === "separator") {
                return <div className="consoleChatSeparator" key={item.id}><span>{item.label}</span></div>;
              }

              if (item.type === "system") {
                return (
                  <div className="consoleChatSystem" key={item.id}>
                    <span>{item.entry.text}</span>
                    {item.entry.time && <time className="consoleChatSystemTime">{item.entry.time}</time>}
                  </div>
                );
              }

              const author = item.outgoing ? "Server" : item.player;
              const lastEntry = item.entries.at(-1)!;
              return (
                <div
                  className={`consoleChatCluster tone-${consoleChatTone(author)} ${item.outgoing ? "is-outgoing" : "is-incoming"}`}
                  key={item.id}
                >
                  <ChatAvatar
                    player={item.player}
                    outgoing={item.outgoing}
                    serverId={serverId}
                    playerHeadsEnabled={playerHeadsEnabled}
                    version={headVersion}
                  />
                  <div className="consoleChatClusterBody">
                    <span className="consoleChatAuthor">{author}</span>
                    {item.entries.map((entry) => (
                      <p
                        className={`consoleChatBubble ${entry.kind === "emote" ? "is-emote" : ""}`.trim()}
                        key={entry.id}
                        title={entry.time ? `${author} at ${entry.time}` : author}
                      >
                        {entry.kind === "emote" ? `${entry.player} ${entry.text}` : entry.text}
                      </p>
                    ))}
                    {lastEntry.time && <time className="consoleChatTime">{lastEntry.time}</time>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!pinnedToLatest && timeline.length > 0 && (
        <div className="consoleChatJump">
          <Button variant="secondary" compact onClick={() => { setPinnedToLatest(true); scrollToLatest("smooth"); }}>
            Jump to latest
          </Button>
        </div>
      )}

      <form className="consoleChatComposer" onSubmit={submitDraft}>
        <input
          className="consoleChatInput"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={canSendCommands ? "Message the server, or start with / to run a command" : disabledReason || "Console command input is unavailable."}
          aria-label="Message the server"
          disabled={!canSendCommands}
          enterKeyHint="send"
          autoComplete="off"
          autoCapitalize="sentences"
        />
        <Button type="submit" compact disabled={!canSendCommands || !draft.trim()} aria-label="Send message">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="consoleChatSendIcon">
            <path d="M4 12h15" />
            <path d="m13 6 6 6-6 6" />
          </svg>
        </Button>
      </form>
      {!canSendCommands && <div className="consoleChatStatus">{disabledReason || "Console command input is unavailable."}</div>}
    </div>
  );
}

function ChatAvatar({
  player,
  outgoing,
  serverId,
  playerHeadsEnabled,
  version
}: {
  player: string;
  outgoing: boolean;
  serverId: string;
  playerHeadsEnabled: boolean;
  version: number;
}) {
  const [failed, setFailed] = useState(false);
  const source = player && serverId ? playerHeadSource(serverId, player, version) : "";
  const showHead = Boolean(source) && playerHeadsEnabled && !failed;

  useEffect(() => setFailed(false), [source, playerHeadsEnabled]);

  if (outgoing) {
    return (
      <span className="consoleChatAvatar consoleChatAvatar--server" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="7" rx="2" />
          <rect x="3" y="13" width="18" height="7" rx="2" />
          <path d="M7 7.5h.01M7 16.5h.01" />
        </svg>
      </span>
    );
  }

  return (
    <span className="consoleChatAvatar" aria-hidden="true">
      {showHead
        ? <img src={source} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : <span className="consoleChatAvatarPlaceholder">{consoleChatInitials(player)}</span>}
    </span>
  );
}
