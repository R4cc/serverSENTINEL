import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget = process.env.VITE_SERVERSENTINEL_API_TARGET ?? "http://localhost:8080";
const backendWsTarget = backendTarget.replace(/^http/, "ws");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: backendTarget,
        // Preserve the browser-facing Vite host so the backend's same-origin
        // CSRF check can validate requests made through the development proxy.
        changeOrigin: false
      },
      "/ws": {
        target: backendWsTarget,
        changeOrigin: false,
        ws: true
      }
    }
  }
});
