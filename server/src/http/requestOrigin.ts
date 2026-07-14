export type OriginRequest = {
  protocol: string;
  headers: Record<string, unknown>;
};

export function firstHeaderToken(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.split(",", 1)[0]?.trim() ?? "" : "";
}

function singleHeaderValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
}

function requestHost(request: OriginRequest, trustProxy: boolean) {
  return (trustProxy ? firstHeaderToken(request.headers["x-forwarded-host"]) : "")
    || firstHeaderToken(request.headers.host);
}

function requestProtocol(request: OriginRequest, trustProxy: boolean) {
  const forwardedProtocol = trustProxy
    ? firstHeaderToken(request.headers["x-forwarded-proto"]).toLowerCase()
    : "";
  if (forwardedProtocol && forwardedProtocol !== "http" && forwardedProtocol !== "https") {
    return { error: "invalid request protocol" } as const;
  }
  return {
    protocol: forwardedProtocol || (request.protocol === "https" ? "https" : "http")
  } as const;
}

export function sameOriginFailure(request: OriginRequest, trustProxy: boolean, requireOrigin = false) {
  const origin = singleHeaderValue(request.headers.origin);
  if (!origin) return requireOrigin ? "missing request origin" : undefined;

  const host = requestHost(request, trustProxy);
  if (!host || /[\r\n]/.test(host)) return "invalid request host";

  const protocolResult = requestProtocol(request, trustProxy);
  if ("error" in protocolResult) return protocolResult.error;

  let actualOrigin: string;
  try {
    actualOrigin = new URL(origin).origin;
  } catch {
    return "invalid request origin";
  }

  const expectedOrigins = new Set([`${protocolResult.protocol}://${host}`]);
  // A host-preserving TLS terminator (including a default Cloudflare Tunnel
  // route) receives HTTPS from the browser and connects to this listener over
  // HTTP. The raw Host header still provides a trustworthy same-origin match,
  // so forwarded headers are not needed for CSRF validation in this topology.
  if (!trustProxy && protocolResult.protocol === "http") {
    expectedOrigins.add(`https://${host}`);
  }

  return expectedOrigins.has(actualOrigin) ? undefined : "cross-origin request rejected";
}

export function requestUsesPublicHttps(request: OriginRequest, trustProxy: boolean) {
  const protocolResult = requestProtocol(request, trustProxy);
  if ("error" in protocolResult) return false;
  if (protocolResult.protocol === "https") return true;
  if (trustProxy) return false;

  const host = requestHost(request, false);
  if (!host || /[\r\n]/.test(host)) return false;
  const origin = singleHeaderValue(request.headers.origin);
  if (!origin) return false;
  try {
    return new URL(origin).origin === `https://${host}`;
  } catch {
    return false;
  }
}
