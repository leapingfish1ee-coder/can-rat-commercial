import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true
      },
      "/health": {
        target: "http://localhost:8787",
        changeOrigin: true
      }
    }
  },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 1200
  }
});
