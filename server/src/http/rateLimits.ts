/** Route-level rate limit options shared by the API route modules. */
export const authRateLimit = { bodyLimit: 16 * 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
export const nodeJoinRateLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
export const provisionRateLimit = { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } };
export const runtimeActionRateLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
export const destructiveRateLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
export const modChangeRateLimit = { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } };
export const commandRateLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
