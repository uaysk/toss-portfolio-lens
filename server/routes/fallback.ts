import { readFileSync } from "node:fs";
import path from "node:path";
import express, { type Express } from "express";

function productionViteAssets(clientDirectory: string, production: boolean): ReadonlySet<string> {
  const files = new Set<string>();
  if (!production) return files;
  const assetDirectory = path.resolve(clientDirectory, "assets");
  try {
    const parsed: unknown = JSON.parse(readFileSync(
      path.join(clientDirectory, ".vite", "manifest.json"),
      "utf8",
    ));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return files;
    for (const value of Object.values(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const candidates = [
        entry.file,
        ...(Array.isArray(entry.css) ? entry.css : []),
        ...(Array.isArray(entry.assets) ? entry.assets : []),
      ];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.startsWith("assets/")) {
          const resolved = path.resolve(clientDirectory, candidate);
          const relative = path.relative(assetDirectory, resolved);
          if (
            relative !== ""
            && relative !== ".."
            && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative)
          ) {
            files.add(resolved);
          }
        }
      }
    }
  } catch {
    // Fail closed: a missing/corrupt manifest costs revalidation but never
    // gives an unknown mutable file an immutable cache lifetime.
  }
  return files;
}

export function registerMcpFallback(app: Express, mcpEnabled: boolean): void {
  app.use([
    "/mcp",
    "/oauth",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
  ], (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(404).json({
      error: {
        code: mcpEnabled ? "mcp-not-found" : "mcp-disabled",
        message: mcpEnabled ? "MCP endpoint was not found." : "MCP endpoint is disabled.",
      },
    });
  });
}

export function registerApiAndSpaFallbacks(
  app: Express,
  input: {
    clientDirectory: string;
    production: boolean;
  },
): void {
  const comparisonReportPath = path.resolve(
    input.clientDirectory,
    "reports",
    "crypto-scalping-model-comparison.html",
  );
  const viteAssets = productionViteAssets(input.clientDirectory, input.production);
  app.use("/api", (_request, response) => {
    // 404 is heuristically cacheable. Do not let a negative API lookup survive
    // a deployment that adds the requested route.
    response.setHeader("Cache-Control", "no-store");
    response.status(404).json({
      error: {
        code: "api-not-found",
        message: "요청한 API 경로를 찾을 수 없습니다.",
      },
    });
  });

  app.use(
    express.static(input.clientDirectory, {
      index: false,
      // Cache only exact content-addressed files recorded by Vite's build
      // manifest. Mutable or unknown files remain revalidation-safe.
      maxAge: 0,
      immutable: false,
      setHeaders: (response, filePath) => {
        if (path.resolve(filePath) === comparisonReportPath) {
          response.setHeader("Cache-Control", "no-store, max-age=0");
          return;
        }
        if (viteAssets.has(path.resolve(filePath))) {
          response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          return;
        }
        response.setHeader("Cache-Control", "no-cache");
      },
    }),
  );

  // A stale HTML document can request a bundle from the previous deployment.
  // Return a real miss instead of feeding index.html to a script/style request.
  app.use("/assets", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(404).type("text/plain").send("Static asset not found.");
  });

  app.get("/{*path}", (_request, response) => {
    response.setHeader("Cache-Control", "no-cache");
    response.sendFile(path.join(input.clientDirectory, "index.html"));
  });
}
