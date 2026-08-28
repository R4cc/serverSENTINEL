import { describe, expect, it } from "vitest";
import { describeLocation, isLocatableAddress, locateAddress, playerLocationFromCityResponse, type GeoCityResponse } from "./geoLocation.js";

function cityResponse(overrides: Partial<GeoCityResponse> = {}): GeoCityResponse {
  return {
    city: { names: { en: "Copenhagen" } },
    subdivisions: [{ isoCode: "84", names: { en: "Capital Region" } }],
    country: { isoCode: "DK", names: { en: "Denmark" } },
    continent: { code: "EU", names: { en: "Europe" } },
    location: { latitude: 55.6759, longitude: 12.5655, accuracyRadius: 20 },
    ...overrides
  };
}

describe("GeoLite2 city answers", () => {
  it("keeps a city that the accuracy radius supports", () => {
    const location = playerLocationFromCityResponse(cityResponse());
    expect(location).toMatchObject({
      label: "Copenhagen",
      city: "Copenhagen",
      country: "Denmark",
      countryCode: "DK",
      continentCode: "EU",
      continent: "Europe",
      accuracyRadiusKm: 20,
      precision: "city"
    });
  });

  it("falls back to the subdivision when the radius is too wide to call it a city", () => {
    const location = playerLocationFromCityResponse(cityResponse({ location: { latitude: 55.6, longitude: 12.5, accuracyRadius: 500 } }));
    expect(location?.precision).toBe("region");
    expect(location?.label).toBe("Capital Region");
    // The city is still recorded — it is the name GeoLite2 gave — but it is not what is presented.
    expect(location?.city).toBe("Copenhagen");
    expect(describeLocation(location)).toBe("Capital Region, Denmark");
  });

  it("draws the city line at fifty kilometres", () => {
    const at = (accuracyRadius: number) =>
      playerLocationFromCityResponse(cityResponse({ location: { latitude: 55.6, longitude: 12.5, accuracyRadius } }))?.precision;
    expect(at(1)).toBe("city");
    expect(at(50)).toBe("city");
    // A hundred kilometres covers several cities, so naming one of them overstates the answer —
    // and GeoLite2 returns radii like this for a great many ordinary allocations.
    expect(at(51)).toBe("region");
    expect(at(100)).toBe("region");
  });

  it("keeps the accuracy radius on a downgraded answer, because the map still draws it", () => {
    const location = playerLocationFromCityResponse(cityResponse({ location: { latitude: 55.6, longitude: 12.5, accuracyRadius: 500 } }));
    expect(location).toMatchObject({ precision: "region", accuracyRadiusKm: 500, latitude: 55.6, longitude: 12.5 });
  });

  it("falls back to the country when a wide answer has no subdivision either", () => {
    const location = playerLocationFromCityResponse(cityResponse({ subdivisions: [], location: { latitude: 56, longitude: 10, accuracyRadius: 1000 } }));
    expect(location?.precision).toBe("country");
    expect(location?.label).toBe("Denmark");
  });

  it("still answers for a country-only record, and reports no answer at all when there is no place", () => {
    expect(playerLocationFromCityResponse({ country: { isoCode: "DK", names: { en: "Denmark" } } })?.precision).toBe("country");
    expect(playerLocationFromCityResponse({})).toBeUndefined();
    expect(playerLocationFromCityResponse({ location: { latitude: 1, longitude: 2 } })).toBeUndefined();
  });

  it("rejects coordinates that are not coordinates", () => {
    const location = playerLocationFromCityResponse(cityResponse({ location: { latitude: 900, longitude: 12.5, accuracyRadius: 5 } }));
    expect(location?.latitude).toBeUndefined();
    expect(location?.longitude).toBe(12.5);
  });
});

describe("which addresses may be located at all", () => {
  it("accepts public addresses", () => {
    for (const address of ["203.0.113.5", "8.8.8.8", "2001:db8::1", "::ffff:203.0.113.5"]) {
      expect(isLocatableAddress(address), address).toBe(true);
    }
  });

  it("refuses addresses that describe a network rather than a place", () => {
    for (const address of [
      "127.0.0.1", "10.1.2.3", "192.168.1.20", "172.16.0.9", "169.254.5.5", "100.64.0.1", "0.0.0.0",
      "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "", "not-an-address"
    ]) {
      expect(isLocatableAddress(address), address).toBe(false);
    }
  });

  it("never asks the reader about an address it refuses, and survives a reader that throws", () => {
    const asked: string[] = [];
    const reader = {
      city(address: string) {
        asked.push(address);
        throw new Error("address not found in database");
      }
    };
    expect(locateAddress(reader, "10.0.0.5")).toBeUndefined();
    expect(asked).toEqual([]);
    expect(locateAddress(reader, "203.0.113.5")).toBeUndefined();
    expect(asked).toEqual(["203.0.113.5"]);
  });

  it("has nothing to say without a database", () => {
    expect(locateAddress(undefined, "203.0.113.5")).toBeUndefined();
  });
});
