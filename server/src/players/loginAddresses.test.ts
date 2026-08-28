import { describe, expect, it } from "vitest";
import { addressWithoutPort, parsePlayerLoginAddress, parsePlayerLoginAddresses } from "./loginAddresses.js";

const referenceDate = new Date("2026-08-16T12:00:00.000Z");

describe("Minecraft login address parsing", () => {
  it("reads the player and address out of a modern login line", () => {
    const login = parsePlayerLoginAddress(
      "[11:59:00] [Server thread/INFO]: SullyTheSnak[/203.0.113.5:51234] logged in with entity id 42 at (12.5, 64.0, -8.5)",
      referenceDate
    );
    expect(login).toMatchObject({ player: "SullyTheSnak", address: "203.0.113.5" });
    // The instant is whatever the shared line parser resolves the runtime-zone wall time to.
    expect(Number.isFinite(Date.parse(login!.at!))).toBe(true);
  });

  it("reads the older game-profile form the same way", () => {
    const login = parsePlayerLoginAddress(
      "[11:59:00] [Server thread/INFO]: com.mojang.authlib.GameProfile@1f[id=abc,name=EnderBobo,properties={}] (/198.51.100.20:49111) logged in with entity id 7",
      referenceDate
    );
    expect(login?.player).toBe("EnderBobo");
    expect(login?.address).toBe("198.51.100.20");
  });

  it("keeps an IPv6 client's address whole", () => {
    const login = parsePlayerLoginAddress(
      "[11:59:00] [Server thread/INFO]: Pixel_Panda[/[2001:db8::1a2b]:51234] logged in with entity id 9",
      referenceDate
    );
    expect(login?.address).toBe("2001:db8::1a2b");
  });

  it("ignores every other line the console produces, including joins and disconnects", () => {
    for (const line of [
      "[11:59:00] [Server thread/INFO]: SullyTheSnak joined the game",
      "[11:59:00] [Server thread/INFO]: SullyTheSnak lost connection: Disconnected",
      "[11:59:00] [Server thread/INFO]: Done (12.345s)! For help, type \"help\"",
      "[11:59:00] [Server thread/INFO]: UUID of player SullyTheSnak is 0d0e0f10-1112-4131-8415-161718191a1b",
      ""
    ]) {
      expect(parsePlayerLoginAddress(line, referenceDate), line).toBeNull();
    }
  });

  it("reads every login in a block of console output", () => {
    const text = [
      "[11:58:00] [Server thread/INFO]: Starting minecraft server version 1.20.2",
      "[11:59:00] [Server thread/INFO]: AlexIsHodde[/203.0.113.5:51234] logged in with entity id 42",
      "[11:59:30] [Server thread/INFO]: AlexIsHodde joined the game",
      "[12:00:00] [Server thread/INFO]: NoobMiner[/198.51.100.7:1234] logged in with entity id 43"
    ].join("\n");
    expect(parsePlayerLoginAddresses(text, referenceDate).map((login) => login.player)).toEqual(["AlexIsHodde", "NoobMiner"]);
  });

  describe("port stripping", () => {
    it("keeps the host and drops the port for both address families", () => {
      expect(addressWithoutPort("/203.0.113.5:51234")).toBe("203.0.113.5");
      expect(addressWithoutPort("[2001:db8::1]:51234")).toBe("2001:db8::1");
      expect(addressWithoutPort("203.0.113.5")).toBe("203.0.113.5");
    });

    it("leaves a bare IPv6 address alone rather than mistaking its last group for a port", () => {
      expect(addressWithoutPort("2001:db8::1")).toBe("2001:db8::1");
      expect(addressWithoutPort("2001:db8::1234")).toBe("2001:db8::1234");
    });
  });
});
