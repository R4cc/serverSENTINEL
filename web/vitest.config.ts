import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default defineConfig((env) => mergeConfig(viteConfig(env), {
  // Preserve mock history behavior from Vitest 4 and the existing Vite transforms.
  test: { clearMocks: false }
}));
