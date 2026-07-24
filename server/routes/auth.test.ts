import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { LoginAttemptLimiter } from "../auth/login-attempt-limiter.js";
import { createAuthRouteRuntime } from "./auth.js";

const servers: Server[] = [];

async function start(input?: {
  limiter?: LoginAttemptLimiter;
  trustProxy?: string[];
}) {
  const app = express();
  if (input?.trustProxy?.length) app.set("trust proxy", input.trustProxy);
  app.use(express.json());
  const runtime = createAuthRouteRuntime({
    dashboardPassword: "dashboard-password",
    readOnlyApiToken: "read-only-token",
    sessionSecret: "session-secret-with-at-least-32-characters",
    secureSessionCookie: false,
    loginLimiter: input?.limiter,
  });
  app.use(runtime.router);
  app.get("/protected", runtime.requireReadOnlyApiToken, (_request, response) => {
    response.json({ ok: true });
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server address is unavailable.");
  return { baseUrl: `http://127.0.0.1:${address.port}`, runtime };
}

async function login(baseUrl: string, password: string, forwardedFor?: string) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
    },
    body: JSON.stringify({ password }),
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe("dashboard authentication routes", () => {
  it("preserves Retry-After, resets on success and keeps session behavior", async () => {
    let now = 1_000;
    const limiter = new LoginAttemptLimiter({
      maximumAttempts: 2,
      windowMs: 10_000,
      maximumEntries: 10,
      now: () => now,
    });
    const { baseUrl } = await start({ limiter });

    expect((await login(baseUrl, "wrong")).status).toBe(401);
    expect((await login(baseUrl, "wrong")).status).toBe(401);
    const blocked = await login(baseUrl, "dashboard-password");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("10");

    now = 11_000;
    const authenticated = await login(baseUrl, "dashboard-password");
    expect(authenticated.status).toBe(200);
    const cookie = authenticated.headers.get("set-cookie");
    expect(cookie).toContain("portfolio_session=");
    const session = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: cookie! },
    });
    expect(await session.json()).toEqual({ authenticated: true });

    expect((await login(baseUrl, "wrong")).status).toBe(401);
    expect(limiter.size).toBe(1);
    expect((await login(baseUrl, "dashboard-password")).status).toBe(200);
    expect(limiter.size).toBe(0);
  });

  it("accepts only the dedicated read-only API token", async () => {
    const { baseUrl } = await start();
    expect((await fetch(`${baseUrl}/protected`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/protected`, {
      headers: { Authorization: "Bearer dashboard-password" },
    })).status).toBe(401);
    const accepted = await fetch(`${baseUrl}/protected`, {
      headers: { Authorization: "Bearer read-only-token" },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
  });

  it("ignores X-Forwarded-For unless the direct proxy is explicitly trusted", async () => {
    const untrustedLimiter = new LoginAttemptLimiter({
      maximumAttempts: 1,
      windowMs: 60_000,
      maximumEntries: 10,
    });
    const untrusted = await start({ limiter: untrustedLimiter });
    expect((await login(untrusted.baseUrl, "wrong", "198.51.100.1")).status).toBe(401);
    expect((await login(untrusted.baseUrl, "wrong", "198.51.100.2")).status).toBe(429);

    const trustedLimiter = new LoginAttemptLimiter({
      maximumAttempts: 1,
      windowMs: 60_000,
      maximumEntries: 10,
    });
    const trusted = await start({
      limiter: trustedLimiter,
      trustProxy: ["127.0.0.1"],
    });
    expect((await login(trusted.baseUrl, "wrong", "198.51.100.1")).status).toBe(401);
    expect((await login(trusted.baseUrl, "wrong", "198.51.100.2")).status).toBe(401);
  });
});
