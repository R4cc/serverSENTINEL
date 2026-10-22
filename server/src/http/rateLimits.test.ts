import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { authRateLimit, globalRateLimit } from "./rateLimits.js";

it("serves static files without spending or being blocked by the API rate budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-rate-limit-"));
  const app = Fastify();
  try {
    await writeFile(join(root, "index.html"), "<!doctype html><title>Panel</title>");
    await writeFile(join(root, "app.js"), "console.log('panel');");
    await app.register(rateLimit, { ...globalRateLimit, max: 2 });
    app.get("/api/app", async () => ({}));
    app.post("/api/auth/login", authRateLimit, async () => ({}));
    await app.register(fastifyStatic, { root, wildcard: false });
    for (let count = 0; count < 5; count++) {
      expect((await app.inject("/app.js?file=/api/app")).statusCode).toBe(200);
    }
    expect((await app.inject("/api/app")).statusCode).toBe(200);
    expect((await app.inject("/api/app")).statusCode).toBe(200);
    expect((await app.inject("/api/app?file=app.js&rootPath=/")).statusCode).toBe(429);
    expect((await app.inject("/")).statusCode).toBe(200);
    expect((await app.inject({ method: "HEAD", url: "/app.js" })).statusCode).toBe(200);
    for (let count = 0; count < 10; count++) {
      expect((await app.inject({ method: "POST", url: "/api/auth/login" })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "POST", url: "/api/auth/login" })).statusCode).toBe(429);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
