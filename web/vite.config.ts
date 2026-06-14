import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget = process.env.VITE_SERVERSENTINEL_API_TARGET ?? "http://localhost:8080";
const backendWsTarget = backendTarget.replace(/^http/, "ws");

function packageChunkName(id: string, prefix: string) {
  const parts = id.split("/node_modules/")[1]?.split("/") ?? [];
  const packageName = parts[0]?.startsWith("@") ? `${parts[0]}-${parts[1]}` : parts[0];
  return packageName ? `${prefix}-${packageName.replace(/^@/, "").replace(/[^a-zA-Z0-9_-]/g, "-")}` : prefix;
}

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");
          if (!normalizedId.includes("/node_modules/")) return undefined;

          if (normalizedId.includes("/@codemirror/") || normalizedId.includes("/@lezer/")) {
            return packageChunkName(normalizedId, "editor");
          }
          if (normalizedId.includes("/style-mod/") || normalizedId.includes("/w3c-keyname/")) {
            return "editor-support";
          }
          if (normalizedId.includes("/@uiw/react-codemirror/")) {
            return "editor-react";
          }
          if (normalizedId.includes("/recharts/") || normalizedId.includes("/d3-") || normalizedId.includes("/decimal.js-light/") || normalizedId.includes("/victory-vendor/")) {
            return "charts";
          }
          if (normalizedId.includes("/@tanstack/react-table/")) {
            return "table";
          }
          if (normalizedId.includes("/react/") || normalizedId.includes("/react-dom/") || normalizedId.includes("/scheduler/")) {
            return "react";
          }
          if (normalizedId.includes("/sonner/")) {
            return "notifications";
          }

          return "vendor";
        }
      }
    }
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": backendTarget,
      "/ws": {
        target: backendWsTarget,
        ws: true
      }
    }
  }
});
