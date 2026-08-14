import { config } from "../config.js";
import { dockerAvailable, dockerRequest } from "./dockerClient.js";

type DockerDaemonInfo = { LiveRestoreEnabled?: boolean };

/**
 * Extra socket read time on top of the container's stop timeout. Docker answers `/stop` and
 * `/restart` only once the container is down, and once the grace period expires it still has to
 * deliver SIGKILL and tear the container down, so the request has to outlast the timeout it asks for.
 */
const stopRequestSlackSeconds = 15;

/** Query suffix that states the stop grace period explicitly rather than relying on the container's. */
export function dockerStopQuery(stopTimeoutSeconds = config.minecraftStopTimeoutSeconds) {
  return `?t=${stopTimeoutSeconds}`;
}

export function dockerStopRequestTimeoutMs(stopTimeoutSeconds = config.minecraftStopTimeoutSeconds) {
  return (stopTimeoutSeconds + stopRequestSlackSeconds) * 1_000;
}

/**
 * A daemon restart - an `apt upgrade` of the Docker package, most commonly - stops every running
 * container unless live-restore is on, and the container's stop timeout only decides how gracefully.
 * Reading the flag lets the panel say so once at startup instead of leaving operators to discover it
 * the next time their world is cut off mid-save. Undefined means Docker could not be asked.
 */
export async function dockerLiveRestoreEnabled() {
  if (!dockerAvailable()) return undefined;
  try {
    // Bounded well under the default: this runs on the startup path, and an advisory warning is not
    // worth holding the panel or a node agent behind an unresponsive socket.
    const info = await dockerRequest<DockerDaemonInfo>("GET", "/info", 200, undefined, 5_000);
    return info.LiveRestoreEnabled === true;
  } catch {
    return undefined;
  }
}

export const dockerLiveRestoreGuidance =
  "Docker live-restore is disabled, so restarting or upgrading the Docker daemon stops every Minecraft container. "
  + "Set \"live-restore\": true in /etc/docker/daemon.json and reload Docker to leave running servers untouched.";
