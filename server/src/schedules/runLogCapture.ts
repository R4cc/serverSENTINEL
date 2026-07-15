const MAX_LOG_ENTRIES = 60;
const MAX_LOG_CHARACTERS = 24_000;

export type ScheduledCommandLogCapture = {
  logs?: string[];
  logCaptureStatus: "captured" | "empty" | "unavailable";
};

function lines(text: string) {
  const result = text.replace(/\r\n?/g, "\n").split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

function boundedEntries(entries: string[]) {
  const recent = entries.filter((entry) => entry.length > 0).slice(-MAX_LOG_ENTRIES);
  let characters = 0;
  const bounded: string[] = [];
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const entry = recent[index];
    if (characters + entry.length > MAX_LOG_CHARACTERS) break;
    bounded.unshift(entry);
    characters += entry.length;
  }
  return bounded;
}

export function captureScheduledCommandLogs(before: string | undefined, after: string | undefined): ScheduledCommandLogCapture {
  if (before === undefined || after === undefined) return { logCaptureStatus: "unavailable" };
  if (before === after) return { logCaptureStatus: "empty", logs: [] };

  if (after.startsWith(before)) {
    const appended = boundedEntries(lines(after.slice(before.length)));
    return appended.length
      ? { logCaptureStatus: "captured", logs: appended }
      : { logCaptureStatus: "empty", logs: [] };
  }

  const beforeLines = lines(before);
  const afterLines = lines(after);
  let overlap = 0;
  for (let length = Math.min(beforeLines.length, afterLines.length); length > 0; length -= 1) {
    const beforeStart = beforeLines.length - length;
    if (beforeLines.slice(beforeStart).every((entry, index) => entry === afterLines[index])) {
      overlap = length;
      break;
    }
  }
  if (overlap === 0) return { logCaptureStatus: "unavailable" };

  const appended = boundedEntries(afterLines.slice(overlap));
  return appended.length
    ? { logCaptureStatus: "captured", logs: appended }
    : { logCaptureStatus: "empty", logs: [] };
}
