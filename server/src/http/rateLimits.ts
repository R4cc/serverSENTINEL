import type { RateLimitPluginOptions } from "@fastify/rate-limit";

/** Route-level rate limit options shared by the API route modules. */
export const authRateLimit = { bodyLimit: 16 * 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
export const nodeJoinRateLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
export const provisionRateLimit = { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } };
export const runtimeActionRateLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
export const destructiveRateLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
/** Chunked imports may need many small requests when a reverse proxy enforces a low body limit. */
export const importChunkRateLimit = { config: { rateLimit: { max: 3_000, timeWindow: "1 minute" } } };
export const modChangeRateLimit = { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } };
export const commandRateLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
export const globalRateLimit: RateLimitPluginOptions = {
  global: true,
  max: 600,
  timeWindow: "1 minute",
  // Only registered static files carry this server-owned metadata. Page loads must
  // not exhaust the API budget or lose their scripts behind a 429 response.
  allowList: (request) => {
    const { file, rootPath } = request.routeOptions.config as { file?: unknown; rootPath?: unknown };
    return typeof file === "string" && typeof rootPath === "string";
  }
};
