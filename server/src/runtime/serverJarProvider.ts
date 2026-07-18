import type { ServerRuntimeType } from "../types.js";
import { McJarsProvider } from "./mcjarsProvider.js";
import { PaperDownloadsProvider } from "./paperProvider.js";
import type { ServerJarProvider } from "./profile.js";

type RuntimeProviders = Record<ServerRuntimeType, ServerJarProvider>;

export class RuntimeServerJarProvider implements ServerJarProvider {
  constructor(private readonly providers: RuntimeProviders = {
    fabric: new McJarsProvider(),
    paper: new PaperDownloadsProvider()
  }) {}

  private provider(runtimeType: ServerRuntimeType) {
    const provider = this.providers[runtimeType];
    if (!provider) throw new Error(`No server jar provider is registered for ${runtimeType}`);
    return provider;
  }

  listMinecraftVersions(runtimeType: ServerRuntimeType, options?: { forceRefresh?: boolean }) {
    return this.provider(runtimeType).listMinecraftVersions(runtimeType, options);
  }

  listRuntimeVersions(runtimeType: ServerRuntimeType, minecraftVersion: string, options?: { forceRefresh?: boolean }) {
    return this.provider(runtimeType).listRuntimeVersions(runtimeType, minecraftVersion, options);
  }

  resolveServerJar(input: Parameters<ServerJarProvider["resolveServerJar"]>[0]) {
    return this.provider(input.runtimeType).resolveServerJar(input);
  }
}

export const defaultServerJarProvider = new RuntimeServerJarProvider();
