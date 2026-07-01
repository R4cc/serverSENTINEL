import { describe, expect, it } from "vitest";
import { modrinthRequestHeaders } from "./modrinthClient.js";

describe("Modrinth client", () => {
  it("only sends the API key to the Modrinth API host", () => {
    expect(modrinthRequestHeaders("https://api.modrinth.com/v2/project/fabric-api", "secret")).toMatchObject({
      Authorization: "secret"
    });

    expect(modrinthRequestHeaders("https://cdn.modrinth.com/data/example.jar", "secret")).not.toHaveProperty("Authorization");
    expect(modrinthRequestHeaders("https://example.invalid/file.jar", "secret")).not.toHaveProperty("Authorization");
    expect(modrinthRequestHeaders("not a url", "secret")).not.toHaveProperty("Authorization");
  });
});
