import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget = process.env.VITE_SERVERSENTINEL_API_TARGET ?? "http://localhost:8080";
const backendWsTarget = backendTarget.replace(/^http/, "ws");

export default defineConfig({
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
