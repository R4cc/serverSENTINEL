import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const screenshotScript = readFileSync(
  new URL("../../scripts/update-readme-screenshots.mjs", import.meta.url),
  "utf8"
);

describe("README screenshot automation", () => {
  it("isolates deterministic data URL fonts from the production CSP", () => {
    expect(screenshotScript).toContain('src: url("data:font/woff2;base64,');
    expect(screenshotScript).toMatch(/browser\.newContext\(\{[\s\S]*?bypassCSP:\s*true/);
  });
});
