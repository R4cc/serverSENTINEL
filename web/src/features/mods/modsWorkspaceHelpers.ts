import type { ModrinthInstallVersionsResponse, ReleaseChannel } from "../../types";

export function preferredInstallVersionId(data: ModrinthInstallVersionsResponse) {
  return data.compatibleVersions.find((version) => version.status === "recommended")?.id
    ?? data.compatibleVersions[0]?.id
    ?? "";
}

export function hasInstallVersions(data: ModrinthInstallVersionsResponse) {
  return data.compatibleVersions.length > 0 || data.otherVersions.length > 0;
}

export function fallbackReleaseChannel(channel: ReleaseChannel): ReleaseChannel | null {
  if (channel === "release") return "beta";
  if (channel === "beta") return "alpha";
  return null;
}
