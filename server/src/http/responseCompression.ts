import compress from "@fastify/compress";
import type { FastifyInstance } from "fastify";

/**
 * Response types worth compressing. This deliberately replaces the plugin default, which also
 * matches `application/octet-stream` and would therefore re-encode every managed file download.
 * Anything this misses still falls through to the mime-db `compressible` flag, which covers
 * JavaScript and marks the archive, image, and font types we serve as incompressible.
 */
export const compressibleResponseTypes = /^text\/(?!event-stream)|(?:\+|\/)json(?:;|$)|(?:\+|\/)xml(?:;|$)/u;

/**
 * Smallest body worth encoding. Below roughly a packet the framing overhead and the lost
 * `Content-Length` cost more than the saved bytes, and most API replies here are small.
 */
export const compressionThresholdBytes = 1024;

/**
 * Compresses text responses -- the frontend bundle and stylesheet, and every JSON API reply.
 * The built assets are the reason this matters: they ship around 790 KiB uncompressed and
 * roughly a quarter of that encoded, on a panel that is usually reached over a home uplink.
 *
 * Request decompression stays off. Nothing in this API accepts a compressed request body, and
 * enabling it would let a client spend the panel's CPU inflating one.
 */
export async function registerResponseCompression(app: FastifyInstance) {
  await app.register(compress, {
    globalCompression: true,
    globalDecompression: false,
    encodings: ["br", "gzip", "deflate"],
    customTypes: compressibleResponseTypes,
    threshold: compressionThresholdBytes
  });
}
