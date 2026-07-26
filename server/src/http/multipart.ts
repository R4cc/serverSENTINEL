import type { FastifyRequest } from "fastify";
import type { RuntimeUploadSource } from "../nodes/types.js";

export async function multipartUpload(request: FastifyRequest, maximumBytes: number) {
  const part = await request.file({ limits: { fileSize: maximumBytes, files: 1 } });
  if (!part) throw new Error("Upload file is required");
  const field = (name: string) => {
    const raw = part.fields[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value && value.type === "field" && typeof value.value === "string" ? value.value : undefined;
  };
  const declaredSize = Number(field("size"));
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maximumBytes) {
    part.file.destroy();
    throw new Error(`Upload size must be between 0 and ${Math.floor(maximumBytes / 1024 / 1024)} MiB`);
  }
  return {
    path: field("path"),
    filename: part.filename,
    content: { stream: part.file, size: declaredSize } satisfies RuntimeUploadSource
  };
}
