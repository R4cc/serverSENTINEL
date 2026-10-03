import { dockerAvailable, dockerBufferRequest, dockerRequest } from "./dockerClient.js";
import { logInfo } from "../logging.js";

/** A cold Minecraft image pull can take several minutes. */
const imagePullTimeoutMs = 10 * 60 * 1000;

function splitImage(image: string) {
  // A digest-pinned reference keeps its whole digest as the tag. Splitting on the last colon would
  // cut `sha256` off the hash and produce a reference the registry cannot resolve.
  const digestIndex = image.lastIndexOf("@");
  if (digestIndex > 0) {
    return { fromImage: image.slice(0, digestIndex), tag: image.slice(digestIndex + 1) };
  }
  const slashIndex = image.lastIndexOf("/");
  const colonIndex = image.lastIndexOf(":");
  if (colonIndex > slashIndex) {
    return { fromImage: image.slice(0, colonIndex), tag: image.slice(colonIndex + 1) };
  }
  return { fromImage: image, tag: "latest" };
}

/**
 * `POST /images/create` answers 200 and then streams progress, so a pull that fails on
 * authentication, a rate limit, or an unknown tag reports its reason inside a successful response.
 * Left unread, provisioning continued and failed later with "No such image", naming the wrong cause.
 */
function assertDockerPullSucceeded(image: string, body: Buffer) {
  for (const line of body.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: { error?: string; errorDetail?: { message?: string } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    const message = parsed.errorDetail?.message ?? parsed.error;
    if (message) throw new Error(`Could not pull Docker image ${image}: ${message}`);
  }
}

export async function ensureDockerImage(image: string) {
  try {
    await dockerRequest("GET", `/images/${encodeURIComponent(image)}/json`, 200);
    return;
  } catch (error) {
    // Only a genuinely absent image is worth a pull. A daemon that is unreachable or unconfigured
    // must surface that, not be retried as if the image were merely missing.
    if (!dockerAvailable()) throw error;
  }
  logInfo({ image }, "Pulling Minecraft runtime image");
  const { fromImage, tag } = splitImage(image);
  const body = await dockerBufferRequest(
    "POST",
    `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
    200,
    // A first pull of a Minecraft runtime image routinely outruns the default socket idle timeout.
    imagePullTimeoutMs
  );
  assertDockerPullSucceeded(image, body);
}
