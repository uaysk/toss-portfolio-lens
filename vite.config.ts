import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist/client",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ["recharts"],
          radix: ["@radix-ui/react-select", "@radix-ui/react-slot"],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3200",
    },
  },
});
