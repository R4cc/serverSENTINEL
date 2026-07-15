import { describe, expect, it } from "vitest";
import { parseServerProperties, serializeServerProperties } from "./serverProperties.js";

describe("server properties", () => {
  it("parses comments, whitespace, and values containing equals signs", () => {
    expect(parseServerProperties("# comment\n motd = hello=world \nempty=\ninvalid\n")).toEqual({ motd: "hello=world", empty: "" });
  });

  it("serializes a canonical trailing newline", () => {
    expect(serializeServerProperties({ online: "true", port: "25565" })).toBe("online=true\nport=25565\n");
  });
});
