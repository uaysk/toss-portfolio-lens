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
    manifest: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (id.includes("commonjsHelpers")) return "commonjs-helpers";
          if (id.endsWith("/src/components/backtest-chart-runtime.ts")) {
            return "backtest-chart-runtime";
          }
          if (id.endsWith("/src/components/report-generate-button.tsx")) {
            return "report-generate-button";
          }
          if (id.includes("/node_modules/react/")
            || id.includes("/node_modules/react-dom/")
            || id.includes("/node_modules/scheduler/")) {
            return "react";
          }
          if (id.includes("/node_modules/recharts/")) return "charts";
          if (id.includes("/node_modules/clsx/")
            || id.includes("/node_modules/tailwind-merge/")) {
            return "class-names";
          }
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
