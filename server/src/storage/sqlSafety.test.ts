import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeLineStarts, createScanner, SyntaxKind } from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";

const storageDirectory = fileURLToPath(new URL(".", import.meta.url));
const queryMethods = new Set(["exec", "pragma", "prepare"]);

function dynamicQueryCalls(path: string) {
  const source = readFileSync(path, "utf8");
  const scanner = createScanner(true, undefined, source);
  const lineStarts = computeLineStarts(source);
  const findings: string[] = [];
  let previous = SyntaxKind.Unknown;
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    if ((previous === SyntaxKind.DotToken || previous === SyntaxKind.QuestionDotToken)
      && token === SyntaxKind.Identifier
      && queryMethods.has(scanner.getTokenValue())) {
      let open = scanner.scan();
      if (open === SyntaxKind.QuestionDotToken) open = scanner.scan();
      if (open !== SyntaxKind.OpenParenToken) {
        previous = open;
        continue;
      }
      const query = scanner.scan();
      if (query !== SyntaxKind.StringLiteral && query !== SyntaxKind.NoSubstitutionTemplateLiteral) {
        const offset = scanner.getTokenStart();
        const line = lineStarts.findLastIndex((start) => start <= offset);
        findings.push(`${path}:${line + 1}:${offset - lineStarts[line]! + 1}`);
      }
      previous = query;
      continue;
    }
    previous = token;
  }
  return findings;
}

describe("SQLite query safety", () => {
  it("keeps production SQL text static so runtime values must use bound parameters", () => {
    const findings = readdirSync(storageDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      .flatMap((entry) => dynamicQueryCalls(fileURLToPath(new URL(entry.name, import.meta.url))));

    expect(findings, "Dynamic SQL call arguments can permit injection; use placeholders and statement bindings").toEqual([]);
  });
});
