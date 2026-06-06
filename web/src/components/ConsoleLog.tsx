import { parseConsoleText } from "../utils/consoleFormatting";

export function ConsoleLog({ entries }: { entries: string[] }) {
  return (
    <>
      {parseConsoleText(entries).map((line, lineIndex) => (
        <pre key={lineIndex}>
          {line.map((segment, segmentIndex) => (
            <span key={segmentIndex} style={segment.style}>{segment.text}</span>
          ))}
        </pre>
      ))}
    </>
  );
}
