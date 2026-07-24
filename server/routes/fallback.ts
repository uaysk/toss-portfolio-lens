import path from "node:path";
import express, { type Express } from "express";

export function registerMcpFallback(app: Express, mcpEnabled: boolean): void {
  app.use([
    "/mcp",
    "/oauth",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
  ], (_request, response) => {
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
  app.use("/api", (_request, response) => {
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
      maxAge: input.production ? "1y" : 0,
      immutable: input.production,
      setHeaders: (response, filePath) => {
        if (path.resolve(filePath) === comparisonReportPath) {
          // Override the production immutable static policy for the evolving
          // single-file comparison artifact.
          response.setHeader("Cache-Control", "no-store, max-age=0");
        }
      },
    }),
  );

  app.get("/{*path}", (_request, response) => {
    response.setHeader("Cache-Control", "no-cache");
    response.sendFile(path.join(input.clientDirectory, "index.html"));
  });
}
