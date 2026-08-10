import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget = process.env.VITE_SERVERSENTINEL_API_TARGET ?? "http://localhost:8080";
const backendWsTarget = backendTarget.replace(/^http/, "ws");

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // React does not change when the app does, but it was being inlined into the
        // content-hashed entry chunk, so every release invalidated it for returning visitors.
        // Assets are served immutable, so splitting it out keeps it cached across deploys.
        manualChunks(id: string) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react-vendor";
          return undefined;
        }
      }
    }
  },
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
