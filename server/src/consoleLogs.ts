import { open } from "node:fs/promises";

export const defaultConsoleLogLineLimit = 5_000;
export const maxConsoleLogLineLimit = 25_000;

const logReadChunkBytes = 64 * 1024;
const maxConsoleLogBytes = 32 * 1024 * 1024;

export function consoleLogLineLimit(value: unknown, fallback = defaultConsoleLogLineLimit) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maxConsoleLogLineLimit) : fallback;
}

export function tailConsoleLogText(text: string, requestedLineLimit: number, startsMidFile = false) {
  if (!text) return "";
  const lineLimit = consoleLogLineLimit(requestedLineLimit);
  const trailingNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  if (startsMidFile) lines.shift();
  const tail = lines.slice(-lineLimit);
  return `${tail.join("\n")}${trailingNewline && tail.length ? "\n" : ""}`;
}

export async function readConsoleLogTail(path: string, requestedLineLimit: number) {
  const lineLimit = consoleLogLineLimit(requestedLineLimit);
  const handle = await open(path, "r");
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error("Console log is not a file");
    if (fileStat.size === 0) return "";

    const chunks: Buffer[] = [];
    let position = fileStat.size;
    let bufferedBytes = 0;
    let newlineCount = 0;
    while (position > 0 && bufferedBytes < maxConsoleLogBytes && newlineCount <= lineLimit) {
      const length = Math.min(logReadChunkBytes, position, maxConsoleLogBytes - bufferedBytes);
      const start = position - length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      for (const byte of chunk) {
        if (byte === 10) newlineCount += 1;
      }
      bufferedBytes += bytesRead;
      position = start;
    }

    return tailConsoleLogText(Buffer.concat(chunks).toString("utf8"), lineLimit, position > 0);
  } finally {
    await handle.close();
  }
}
