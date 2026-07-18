export function summarizeRuntimeExit(action: "start" | "restart", logs: string) {
  const trimmedLogs = logs.trim();
  const unknownHost = trimmedLogs.match(/UnknownHostException:\s*([^\s\r\n]+)/)?.[1]
    ?? trimmedLogs.match(/Request to https?:\/\/([^/\s]+)[^\r\n]* failed/i)?.[1];

  if (unknownHost) {
    return `Minecraft runtime container exited after ${action}: the container could not resolve ${unknownHost}. Check DNS and outbound network access from the node host and from Docker runtime containers. Minecraft runtimes may need outbound HTTPS access to Mojang metadata on first start.`;
  }

  if (/Temporary failure in name resolution|Name or service not known|getaddrinfo/i.test(trimmedLogs)) {
    return `Minecraft runtime container exited after ${action}: DNS resolution failed inside the runtime container. Check the node host DNS settings and Docker container networking.`;
  }

  if (/Network is unreachable|No route to host|Connection timed out|Connection refused/i.test(trimmedLogs)) {
    return `Minecraft runtime container exited after ${action}: outbound network access failed inside the runtime container. Check firewall, proxy, and Docker network settings on the node host.`;
  }

  return `Minecraft runtime container exited after ${action}${trimmedLogs ? `: ${trimmedLogs.slice(-800)}` : ""}`;
}
