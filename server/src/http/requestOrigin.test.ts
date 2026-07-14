import { describe, expect, it } from "vitest";
import { requestUsesPublicHttps, sameOriginFailure } from "./requestOrigin.js";

function request(headers: Record<string, unknown>, protocol = "http") {
  return { headers, protocol };
}

describe("request origin handling", () => {
  it("accepts a host-preserving HTTPS terminator without trusting forwarded headers", () => {
    const tunneled = request({
      host: "panel.example.com",
      origin: "https://panel.example.com",
      "x-forwarded-host": "spoofed.example.com",
      "x-forwarded-proto": "javascript"
    });

    expect(sameOriginFailure(tunneled, false, true)).toBeUndefined();
    expect(requestUsesPublicHttps(tunneled, false)).toBe(true);
  });

  it("still rejects a different browser origin when the public Host is preserved", () => {
    expect(sameOriginFailure(request({
      host: "panel.example.com",
      origin: "https://evil.example.com"
    }), false)).toBe("cross-origin request rejected");
    expect(sameOriginFailure(request({
      host: "panel.example.com",
      origin: "https://panel.example.com, https://evil.example.com"
    }), false)).toBe("invalid request origin");
  });

  it("requires explicit trust when a proxy rewrites the Host header", () => {
    const rewritten = request({
      host: "serversentinel:8080",
      origin: "https://panel.example.com",
      "x-forwarded-host": "panel.example.com",
      "x-forwarded-proto": "https"
    });

    expect(sameOriginFailure(rewritten, false)).toBe("cross-origin request rejected");
    expect(requestUsesPublicHttps(rewritten, false)).toBe(false);
    expect(sameOriginFailure(rewritten, true)).toBeUndefined();
    expect(requestUsesPublicHttps(rewritten, true)).toBe(true);
  });

  it("does not allow an HTTP browser origin to claim an HTTPS backend request", () => {
    expect(sameOriginFailure(request({
      host: "panel.example.com",
      origin: "http://panel.example.com"
    }, "https"), false)).toBe("cross-origin request rejected");
  });
});
