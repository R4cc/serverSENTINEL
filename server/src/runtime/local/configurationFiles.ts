import { readContainedFile, validateExistingInsideServer, writeContainedFile, type ServerPathScope } from "../../core.js";

// Match the editor limit; ordinary properties, EULA, and version metadata are much smaller.
export const serverConfigurationMaxBytes = 2 * 1024 * 1024;

export async function readServerConfiguration(scope: ServerPathScope, path: string) {
  const target = await validateExistingInsideServer(scope, path);
  return (await readContainedFile(target, serverConfigurationMaxBytes)).toString("utf8");
}

export async function writeServerConfiguration(scope: ServerPathScope, path: string, content: string) {
  if (Buffer.byteLength(content) > serverConfigurationMaxBytes) throw new Error("Server configuration exceeds the 2 MiB limit");
  await writeContainedFile(scope, path, content);
}
