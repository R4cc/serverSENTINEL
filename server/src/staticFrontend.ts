import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { apiErrorResponse } from "./http/errors.js";

export const htmlCacheControl = "no-cache, no-transform";
export const immutableAssetCacheControl = "public, max-age=31536000, immutable";
export const publicAssetCacheControl = "public, max-age=3600, must-revalidate";

export function frontendCacheControl(webDist: string, path: string) {
  if (basename(path) === "index.html") return htmlCacheControl;
  const relativePath = relative(webDist, path).replace(/\\/g, "/");
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
