import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { apiErrorResponse } from "./http/errors.js";

export async function registerStaticFrontend(app: FastifyInstance) {
  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (!existsSync(webDist)) return;

  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
    wildcard: false
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api/") || request.raw.url?.startsWith("/ws/")) {
      reply.code(404).send(apiErrorResponse("NOT_FOUND", "Not found"));
      return;
    }
    reply.sendFile("index.html");
  });
}
