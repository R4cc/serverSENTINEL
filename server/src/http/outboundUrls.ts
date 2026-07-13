function parseSecureUrl(value: string, label: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
    throw new Error(`${label} must be a credential-free HTTPS URL on the standard port`);
  }
  return parsed;
}

function sameOrSubdomain(hostname: string, root: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const normalizedRoot = root.toLowerCase().replace(/\.$/, "");
  return host === normalizedRoot || host.endsWith(`.${normalizedRoot}`);
}

export function assertModrinthUrl(value: string) {
  const parsed = parseSecureUrl(value, "Modrinth URL");
  if (!sameOrSubdomain(parsed.hostname, "modrinth.com")) {
    throw new Error("Modrinth URL must use a modrinth.com host");
  }
  return parsed.toString();
}

export function assertMcJarsArtifactUrl(value: string, baseUrl: string) {
  const parsed = parseSecureUrl(value, "MCJars artifact URL");
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("MCJARS_BASE_URL must be a valid URL");
  }
  if (!sameOrSubdomain(parsed.hostname, base.hostname) && !sameOrSubdomain(parsed.hostname, "mcjars.app")) {
    throw new Error("MCJars artifact URL must use the configured MCJars host, mcjars.app, or one of their subdomains");
  }
  return parsed.toString();
}
