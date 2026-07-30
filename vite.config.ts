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
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (id.includes("/node_modules/react/")
            || id.includes("/node_modules/react-dom/")
            || id.includes("/node_modules/scheduler/")) {
            return "react";
          }
          if (id.includes("/node_modules/recharts/")) return "charts";
          if (id.includes("/node_modules/@radix-ui/")) return "radix";
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${process.env.API_PORT ?? "3200"}`,
    },
  },
});
