/**
 * Console frames originate from a managed workload, which controls how fast they arrive, while the
 * browser on the other end controls how fast they drain. Sending unconditionally lets the gap between
 * the two accumulate in the panel's WebSocket queue, so every console producer pushes through a sender
 * that drops frames once the queue passes a ceiling and tells the viewer what it missed.
 */

export type BackpressuredClient = {
  send: (payload: string) => void;
  readyState: number;
  /** `ws` sockets expose this; a plain test double may not, in which case no frame is ever dropped. */
  bufferedAmount?: number;
};

export const consoleClientMaxQueuedBytes = 8 * 1024 * 1024;

export type ConsoleSender = {
  /** Sends the event unless the client is too far behind. Returns false when the frame was dropped. */
  send: (event: unknown) => boolean;
  /** Frames dropped so far, for logging when the stream closes. */
  droppedFrames: () => number;
};

export function createConsoleSender(
  client: BackpressuredClient,
  maxQueuedBytes = consoleClientMaxQueuedBytes
): ConsoleSender {
  let dropped = 0;
  let noticePending = false;

  const write = (event: unknown) => client.send(JSON.stringify(event));

  return {
    send(event) {
      if (client.readyState !== 1) return false;
      const queued = client.bufferedAmount ?? 0;
      if (queued > maxQueuedBytes) {
        dropped += 1;
        noticePending = true;
        return false;
      }
      // Once the viewer catches up, say so before resuming: a silent gap in a console reads as a bug in
      // the server being managed rather than as a dropped frame.
      if (noticePending) {
        noticePending = false;
        write({
          type: "truncated",
          message: `Console output was dropped because this viewer fell behind (${dropped} frame${dropped === 1 ? "" : "s"}).`,
          droppedFrames: dropped,
          at: new Date().toISOString()
        });
      }
      write(event);
      return true;
    },
    droppedFrames: () => dropped
  };
}
