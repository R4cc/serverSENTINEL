import { describe, expect, it } from "vitest";
import { parseServerProperties, serializeServerProperties, updateServerPropertiesText } from "./serverProperties.js";

describe("server properties", () => {
  it("parses comments, whitespace, and values containing equals signs", () => {
    expect(parseServerProperties("# comment\n motd = hello=world \nempty=\ninvalid\n")).toEqual({ motd: "hello=world", empty: "" });
  });

  it("serializes a canonical trailing newline", () => {
    expect(serializeServerProperties({ online: "true", port: "25565" })).toBe("online=true\nport=25565\n");
  });

  it("reads the colon and whitespace separators Java properties accept", () => {
    expect(parseServerProperties("motd:Hello World\nlevel-name world\nmax-players = 20\n! bang comment\n")).toEqual({
      motd: "Hello World",
      "level-name": "world",
      "max-players": "20"
    });
  });

  it("keeps comments and untouched settings when one setting is saved", () => {
    const original = "#Minecraft server properties\n#Fri Nov 27 10:00:00 UTC 2026\nmotd:Hello World\nserver-port=25565\n\nlevel-name = world\n";
    expect(updateServerPropertiesText(original, { "max-players": "20", "server-port": "25570" })).toBe(
      "#Minecraft server properties\n#Fri Nov 27 10:00:00 UTC 2026\nmotd:Hello World\nserver-port=25570\n\nlevel-name = world\nmax-players=20\n"
    );
  });

  it("rewrites a setting written with another separator and collapses repeated keys", () => {
    expect(updateServerPropertiesText("motd:old\r\nmotd=older\r\npvp=true", { motd: "new" })).toBe("motd=new\r\npvp=true\r\n");
  });

  it("writes a fresh file when there is none", () => {
    expect(updateServerPropertiesText(undefined, { "server-port": "25565" })).toBe("server-port=25565\n");
  });
});
