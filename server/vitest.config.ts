import { defineConfig } from "vitest/config";

export default defineConfig({
  // Preserve mock history behavior from Vitest 4.
  test: { clearMocks: false }
});
