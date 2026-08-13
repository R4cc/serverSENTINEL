import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { apiErrorResponse } from "./http/errors.js";

export const htmlCacheControl = "no-cache, no-transform";
export const immutableAssetCacheControl = "public, max-age=31536000, immutable";
export const publicAssetCacheControl = "public, max-age=3600, must-revalidate";

/**
 * A precompressed hit is served from a sibling `.br` file, so the path this sees carries the
 * encoding suffix. The policy belongs to the resource, not to the encoding it arrived in.
 */
function withoutEncodingSuffix(path: string) {
  return path.replace(/\.(?:br|gz)$/, "");
}

export function frontendCacheControl(webDist: string, path: string) {
  const resourcePath = withoutEncodingSuffix(path);
  if (basename(resourcePath) === "index.html") return htmlCacheControl;
  const relativePath = relative(webDist, resourcePath).replace(/\\/g, "/");
  return relativePath.startsWith("assets/") ? immutableAssetCacheControl : publicAssetCacheControl;
}

export async function registerStaticFrontend(app: FastifyInstance) {
  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (!existsSync(webDist)) return;

  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
    wildcard: false,
    cacheControl: false,
    // The build writes a maximum-quality `.br` beside every text asset. Serving it sends a smaller
    // body than the request-time encoder can produce and spends no CPU doing it. Gzip-only clients
    // fall back to the plain file, which `@fastify/compress` encodes on demand.
    preCompressed: true,
    setHeaders(reply, path) {
      // HTML must revalidate and must not be transformed by Cloudflare, which also
      // keeps Browser Insights injection disabled. Vite fingerprints /assets files,
      // while stable public filenames retain a short, explicit cache lifetime.
      reply.header("Cache-Control", frontendCacheControl(webDist, path));
    }
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api/") || request.raw.url?.startsWith("/ws/")) {
      reply.code(404).send(apiErrorResponse("NOT_FOUND", "Not found"));
      return;
    }
    reply.sendFile("index.html");
  });
}
