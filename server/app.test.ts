import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createAuthRouteRuntime } from "./routes/auth.js";
import {
  registerApiAndSpaFallbacks,
  registerMcpFallback,
} from "./routes/fallback.js";

const servers: Server[] = [];
const directories: string[] = [];

async function fixture(mcpEnabled = false) {
  const clientDirectory = mkdtempSync(path.join(tmpdir(), "portfolio-lens-app-"));
  directories.push(clientDirectory);
  writeFileSync(
    path.join(clientDirectory, "index.html"),
    "<!doctype html><html><body>portfolio-spa-fixture</body></html>",
  );
  const app = createApp({ trustProxy: [] });
  if (mcpEnabled) {
    app.get("/mcp", (_request, response) => response.json({ protocol: "mcp" }));
    app.get("/.well-known/oauth-protected-resource", (_request, response) => {
      response.json({ resource: "fixture" });
    });
  }
  registerMcpFallback(app, mcpEnabled);
  const auth = createAuthRouteRuntime({
    dashboardPassword: "dashboard-password",
    readOnlyApiToken: "read-only-token",
    sessionSecret: "session-secret-with-at-least-32-characters",
    secureSessionCookie: false,
  });
  app.use(auth.router);
  app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
  registerApiAndSpaFallbacks(app, { clientDirectory, production: false });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server address is unavailable.");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("application route ordering", () => {
  it("returns JSON 404 for unknown API methods without reaching the SPA", async () => {
    const baseUrl = await fixture();
    for (const request of [
      { method: "GET" as const },
      { method: "POST" as const },
      {
        method: "POST" as const,
        headers: { "Content-Type": "application/json" },
        body: "{",
      },
      {
        method: "POST" as const,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ignored: "x".repeat(32 * 1024) }),
      },
    ]) {
      const response = await fetch(`${baseUrl}/api/does-not-exist`, request);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({
        error: {
          code: "api-not-found",
          message: "요청한 API 경로를 찾을 수 없습니다.",
        },
      });
    }
  });

  it("keeps malformed bodies on registered routes in the JSON error boundary", async () => {
    const baseUrl = await fixture();
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: {
        code: "invalid-request-body",
        message: "요청 본문의 형식이 올바르지 않습니다.",
      },
    });

    const valid = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "dashboard-password" }),
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ authenticated: true });

    const validTrailingSlash = await fetch(`${baseUrl}/api/auth/login/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "dashboard-password" }),
    });
    expect(validTrailingSlash.status).toBe(200);
    expect(await validTrailingSlash.json()).toEqual({ authenticated: true });
  });

  it("preserves the SPA deep link and normal health/auth routes", async () => {
    const baseUrl = await fixture();
    const deepLink = await fetch(`${baseUrl}/some-ui-route`);
    expect(deepLink.status).toBe(200);
    expect(deepLink.headers.get("content-type")).toContain("text/html");
    expect(await deepLink.text()).toContain("portfolio-spa-fixture");

    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    const session = await fetch(`${baseUrl}/api/auth/session`);
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ authenticated: false });
  });

  it("keeps disabled and unknown MCP paths out of the HTML fallback", async () => {
    const disabled = await fixture(false);
    for (const pathName of [
      "/mcp",
      "/mcp/does-not-exist",
      "/.well-known/oauth-protected-resource",
      "/oauth/does-not-exist",
    ]) {
      const response = await fetch(`${disabled}${pathName}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect((await response.json()).error.code).toBe("mcp-disabled");
    }
    const malformedUnknown = await fetch(`${disabled}/mcp/does-not-exist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformedUnknown.status).toBe(404);
    expect(malformedUnknown.headers.get("content-type")).toContain("application/json");
    expect((await malformedUnknown.json()).error.code).toBe("mcp-disabled");
    const oversizedUnknown = await fetch(`${disabled}/mcp/does-not-exist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignored: "x".repeat(32 * 1024) }),
    });
    expect(oversizedUnknown.status).toBe(404);
    expect(oversizedUnknown.headers.get("content-type")).toContain("application/json");
    expect((await oversizedUnknown.json()).error.code).toBe("mcp-disabled");

    const enabled = await fixture(true);
    expect((await fetch(`${enabled}/mcp`)).status).toBe(200);
    expect((await fetch(`${enabled}/.well-known/oauth-protected-resource`)).status).toBe(200);
    const unknown = await fetch(`${enabled}/mcp/does-not-exist`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");
    expect((await unknown.json()).error.code).toBe("mcp-not-found");
    const unknownOauth = await fetch(`${enabled}/oauth/does-not-exist`);
    expect(unknownOauth.status).toBe(404);
    expect(unknownOauth.headers.get("content-type")).toContain("application/json");
    expect((await unknownOauth.json()).error.code).toBe("mcp-not-found");
  });
});
