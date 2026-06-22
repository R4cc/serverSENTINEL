import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const storageDirectory = fileURLToPath(new URL(".", import.meta.url));
const queryMethods = new Set(["exec", "pragma", "prepare"]);

function dynamicQueryCalls(path: string) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const findings: string[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && queryMethods.has(node.expression.name.text)) {
      const query = node.arguments[0];
      if (query && !ts.isStringLiteral(query) && !ts.isNoSubstitutionTemplateLiteral(query)) {
        const position = source.getLineAndCharacterOfPosition(query.getStart(source));
        findings.push(`${path}:${position.line + 1}:${position.character + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
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
