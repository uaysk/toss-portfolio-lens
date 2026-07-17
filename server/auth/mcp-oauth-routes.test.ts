import { createHash, generateKeyPairSync } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "../database.js";
import { createMcpOAuthRuntime, type McpOAuthRuntime } from "./mcp-oauth-routes.js";

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

function csrf(html: string): string {
  const value = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!value) throw new Error("CSRF token not found");
  return value;
}

describe("MCP OAuth HTTP routes", () => {
  let database: SqliteDatabase | undefined;
  let runtime: McpOAuthRuntime | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await runtime?.cleanup().catch(() => undefined);
    await database?.close();
  });

  it("metadata부터 PKCE token, rotation, reuse detection, revocation까지 수행한다", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    database = new SqliteDatabase(":memory:");
    const resource = "http://127.0.0.1/mcp";
    const issuer = "http://127.0.0.1";
    const redirectUri = "https://chatgpt.example/oauth/callback";
    runtime = await createMcpOAuthRuntime({
      database,
      oauth: {
        issuer,
        clientId: "chatgpt-client",
        clientName: "Toss Portfolio Lens ChatGPT",
        clientSecret: "client-secret-not-for-owner-session",
        redirectUri,
        signingPrivateKeyPem: privateKey,
        autoApprove: false,
        accessTokenTtlSeconds: 3_600,
        refreshTokenTtlSeconds: 2_592_000,
        authorizationCodeTtlSeconds: 300,
        loginSessionTtlSeconds: 900,
      },
      resourceUrl: resource,
      dashboardPassword: "owner-password",
      dashboardSessionSecret: "dashboard-session-secret-that-is-at-least-32-characters",
      publicAppUrl: issuer,
      maxRequestsPerMinute: 20,
    });
    const app = express();
    app.use(express.json({ limit: "16kb" }));
    app.use(express.urlencoded({ extended: false, limit: "16kb" }));
    app.use(runtime.router);
    app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    const base = `http://127.0.0.1:${address.port}`;

    const unrelated = await Promise.all(Array.from({ length: 25 }, () => fetch(`${base}/api/health`)));
    expect(unrelated.every((response) => response.status === 200)).toBe(true);

    const protectedMetadata = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(protectedMetadata).toMatchObject({ resource, authorization_servers: [issuer] });
    const authorizationMetadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(authorizationMetadata).toMatchObject({
      issuer,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
    const jwks = await (await fetch(`${base}/oauth/jwks.json`)).json();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).not.toHaveProperty("d");

    const verifier = "a".repeat(64);
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    const state = "state-value-preserved-byte-for-byte";
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: "chatgpt-client",
      redirect_uri: redirectUri,
      resource,
      scope: "market:read backtest:run",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    const loginPage = await fetch(authorize, { redirect: "manual" });
    expect(loginPage.status).toBe(200);
    const setCookie = loginPage.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const ownerCookie = setCookie.split(";", 1)[0];
    const loginHtml = await loginPage.text();
    expect(loginHtml).toContain("대시보드 비밀번호");
    expect(loginHtml).not.toContain("client-secret-not-for-owner-session");

    const login = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: ownerCookie },
      body: form({ csrf: csrf(loginHtml), action: "login", password: "owner-password" }),
    });
    expect(login.status).toBe(200);
    const approvalHtml = await login.text();
    expect(approvalHtml).toContain("Toss Portfolio Lens ChatGPT");
    expect(approvalHtml).toContain("시장 데이터 조회");
    expect(approvalHtml).toContain("허용");
    expect(approvalHtml).toContain("거부");
    expect(approvalHtml).not.toContain("owner-password");

    const approval = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: ownerCookie },
      body: form({ csrf: csrf(approvalHtml), action: "approve" }),
    });
    expect(approval.status).toBe(302);
    const callback = new URL(approval.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe(state);
    const code = callback.searchParams.get("code")!;

    const tokenResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        client_id: "chatgpt-client",
        client_secret: "client-secret-not-for-owner-session",
        redirect_uri: redirectUri,
        resource,
        code,
        code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const issued = await tokenResponse.json();
    const authInfo = await runtime.verifier.verifyAccessToken(issued.access_token);
    expect(authInfo).toMatchObject({ clientId: "chatgpt-client", scopes: ["market:read", "backtest:run"] });
    expect(authInfo.extra?.sub).toBe("owner");

    const rotatedResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: "chatgpt-client",
        client_secret: "client-secret-not-for-owner-session",
        resource,
        refresh_token: issued.refresh_token,
        scope: "market:read",
      }),
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json();
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);
    expect(rotated.scope).toBe("market:read");

    const reuse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: "chatgpt-client",
        client_secret: "client-secret-not-for-owner-session",
        resource,
        refresh_token: issued.refresh_token,
      }),
    });
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ error: "invalid_grant" });

    const revoke = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: "chatgpt-client",
        client_secret: "client-secret-not-for-owner-session",
        token: rotated.access_token,
        token_type_hint: "refresh_token",
      }),
    });
    expect(revoke.status).toBe(200);
    await expect(runtime.verifier.verifyAccessToken(rotated.access_token)).rejects.toThrow();

    const wrongRedirect = new URL(authorize);
    wrongRedirect.searchParams.set("redirect_uri", `${redirectUri}/wrong`);
    expect((await fetch(wrongRedirect, { redirect: "manual" })).status).toBe(400);
  });
});
