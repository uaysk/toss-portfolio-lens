import { createHmac, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { decodeJwt } from "jose";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { RelationalDatabase } from "../database.js";
import type { McpOAuthConfig } from "../env.js";
import { passwordsMatch, setNoStore } from "../auth.js";
import {
  OAuthRepository,
  OAuthRepositoryError,
} from "../repositories/oauth-repository.js";
import {
  MCP_SCOPES,
  validateRequestedScopes,
  type McpScopeId,
} from "./mcp-scope.js";
import {
  McpOAuthService,
  generateOpaqueToken,
  type OAuthSessionCookiePayload,
} from "./mcp-oauth.js";
import { McpTokenVerifier } from "./mcp-token-verifier.js";

type PendingAuthorization = {
  sessionId: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  state?: string;
  scopes: McpScopeId[];
  codeChallenge: string;
  csrfToken: string;
  authenticated: boolean;
  createdAt: number;
  expiresAt: number;
};

type Attempt = { count: number; resetAt: number };

export type McpOAuthRuntime = {
  router: Router;
  repository: OAuthRepository;
  service: McpOAuthService;
  verifier: McpTokenVerifier;
  cleanup: () => Promise<void>;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function endpoint(issuer: string, path: string): string {
  const url = new URL(issuer);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function ownerPage(input: {
  title: string;
  clientName: string;
  scopes: McpScopeId[];
  csrf: string;
  authenticated: boolean;
  error?: string;
}): string {
  const scopeItems = input.scopes.map((scope) => {
    const definition = MCP_SCOPES.find((item) => item.id === scope)!;
    return `<li><strong>${escapeHtml(definition.name)}</strong><span>${escapeHtml(definition.descriptionKo)}</span></li>`;
  }).join("");
  const body = input.authenticated
    ? `<p class="intro"><strong>${escapeHtml(input.clientName)}</strong> 앱이 다음 권한을 요청합니다.</p>
       <ul>${scopeItems}</ul>
       <div class="actions">
         <button class="primary" name="action" value="approve" type="submit">허용</button>
         <button class="secondary" name="action" value="deny" type="submit">거부</button>
       </div>`
    : `<p class="intro">Toss Portfolio Lens 소유자 비밀번호로 본인 확인을 해주세요.</p>
       <label for="password">대시보드 비밀번호</label>
       <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
       <button class="primary full" name="action" value="login" type="submit">계속</button>`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(input.title)}</title><style>
  :root{color-scheme:light dark;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f6f8;color:#191f28}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(100%,560px);background:#fff;border:1px solid #e5e8eb;border-radius:20px;padding:32px;box-shadow:0 12px 36px rgba(0,0,0,.08);overflow-wrap:anywhere}.eyebrow{margin:0 0 8px;color:#3182f6;font-weight:700}.intro{line-height:1.6}h1{font-size:28px;margin:0 0 18px}label{display:block;margin:20px 0 8px;font-weight:650}input{width:100%;min-width:0;border:1px solid #d1d6db;border-radius:12px;padding:14px;font:inherit;background:transparent;color:inherit}ul{list-style:none;margin:20px 0;padding:0;display:grid;gap:10px}li{display:grid;gap:4px;padding:14px;background:#f2f4f6;border-radius:12px}li span{color:#6b7684;font-size:14px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:24px}button{border:0;border-radius:12px;padding:14px 18px;font:inherit;font-weight:700;cursor:pointer}.primary{background:#3182f6;color:#fff}.secondary{background:#e5e8eb;color:#333}.full{width:100%;margin-top:18px}.error{padding:12px;border-radius:10px;background:#fff0f0;color:#d22030}@media(prefers-color-scheme:dark){:root{background:#101214;color:#f2f4f6}.card{background:#17191c;border-color:#33383e}li{background:#22262a}li span{color:#b0b8c1}.secondary{background:#343a40;color:#fff}input{border-color:#4e5968}}@media(max-width:480px){body{padding:16px}.card{padding:24px 18px;border-radius:16px}h1{font-size:24px}.actions{grid-template-columns:1fr}}
  </style></head><body><main class="card"><p class="eyebrow">Toss Portfolio Lens</p><h1>${escapeHtml(input.title)}</h1>${input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : ""}<form method="post" action="/oauth/authorize"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">${body}</form></main></body></html>`;
}

function oauthError(response: Response, status: number, error: string, description: string): void {
  setNoStore(response);
  response.status(status).json({ error, error_description: description });
}

function stringField(request: Request, name: string): string {
  const value = request.body?.[name];
  return typeof value === "string" ? value : "";
}

function authorizationRedirect(pending: PendingAuthorization, values: Record<string, string>): string {
  const target = new URL(pending.redirectUri);
  for (const [key, value] of Object.entries(values)) target.searchParams.set(key, value);
  if (pending.state) target.searchParams.set("state", pending.state);
  return target.toString();
}

function requestIp(request: Request): string {
  return request.socket.remoteAddress ?? "unknown";
}

export async function createMcpOAuthRuntime(input: {
  database: RelationalDatabase;
  oauth: McpOAuthConfig;
  resourceUrl: string;
  dashboardPassword: string;
  dashboardSessionSecret: string;
  publicAppUrl: string;
  maxRequestsPerMinute: number;
}): Promise<McpOAuthRuntime> {
  const repository = new OAuthRepository(input.database);
  await repository.ensureSchema();
  const privateKey = createPrivateKey(input.oauth.signingPrivateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const sessionSigningSecret = createHmac("sha256", input.dashboardSessionSecret)
    .update("toss-portfolio-lens:mcp-oauth-owner-session:v1")
    .digest("base64url");
  const service = new McpOAuthService({
    privateKey,
    issuer: input.oauth.issuer,
    audience: input.resourceUrl,
    keyId: "toss-portfolio-lens-mcp-1",
    clientSecret: input.oauth.clientSecret,
    sessionSigningSecret,
    expectedClientId: input.oauth.clientId,
  });
  const verifier = new McpTokenVerifier({
    issuer: input.oauth.issuer,
    audience: input.resourceUrl,
    key: publicKey,
    repository,
    expectedClientId: input.oauth.clientId,
  });
  const router = Router();
  const sessions = new Map<string, PendingAuthorization>();
  const attempts = new Map<string, Attempt>();
  const requestBuckets = new Map<string, Attempt>();
  const cookieName = "mcp_oauth_owner";
  const secureCookie = new URL(input.oauth.issuer).protocol === "https:";
  const oauthRateLimitedPaths = new Set([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/oauth/jwks.json",
    "/oauth/authorize",
    "/oauth/token",
    "/oauth/revoke",
  ]);

  router.use((request, response, next) => {
    if (!oauthRateLimitedPaths.has(request.path)) {
      next();
      return;
    }
    const now = Date.now();
    const key = requestIp(request);
    const previous = requestBuckets.get(key);
    const bucket = previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + 60_000 };
    bucket.count += 1;
    requestBuckets.set(key, bucket);
    if (bucket.count > input.maxRequestsPerMinute) {
      response.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      oauthError(response, 429, "temporarily_unavailable", "요청이 너무 많습니다.");
      return;
    }
    next();
  });

  router.get("/.well-known/oauth-protected-resource", (_request, response) => {
    setNoStore(response);
    response.json({
      resource: input.resourceUrl,
      authorization_servers: [input.oauth.issuer],
      scopes_supported: MCP_SCOPES.map((scope) => scope.id),
      bearer_methods_supported: ["header"],
      resource_documentation: `${input.publicAppUrl.replace(/\/+$/, "")}/#mcp-chatgpt`,
    });
  });

  router.get("/.well-known/oauth-authorization-server", (_request, response) => {
    setNoStore(response);
    response.json({
      issuer: input.oauth.issuer,
      authorization_endpoint: endpoint(input.oauth.issuer, "/oauth/authorize"),
      token_endpoint: endpoint(input.oauth.issuer, "/oauth/token"),
      revocation_endpoint: endpoint(input.oauth.issuer, "/oauth/revoke"),
      jwks_uri: endpoint(input.oauth.issuer, "/oauth/jwks.json"),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      scopes_supported: MCP_SCOPES.map((scope) => scope.id),
    });
  });

  router.get("/oauth/jwks.json", async (_request, response) => {
    setNoStore(response);
    response.json(await service.exportJwks());
  });

  router.get("/oauth/authorize", (request, response) => {
    setNoStore(response);
    try {
      if (request.query.response_type !== "code") throw new Error("response_type=code가 필요합니다.");
      if (request.query.client_id !== input.oauth.clientId) throw new Error("client_id가 올바르지 않습니다.");
      if (request.query.redirect_uri !== input.oauth.redirectUri) throw new Error("redirect_uri가 등록값과 일치하지 않습니다.");
      if (request.query.resource !== input.resourceUrl) throw new Error("resource가 MCP resource URL과 일치해야 합니다.");
      if (request.query.code_challenge_method !== "S256") throw new Error("PKCE S256이 필요합니다.");
      const codeChallenge = typeof request.query.code_challenge === "string" ? request.query.code_challenge : "";
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) throw new Error("code_challenge 형식이 올바르지 않습니다.");
      const scopes = validateRequestedScopes(typeof request.query.scope === "string" ? request.query.scope : "");
      if (!scopes.length) throw new Error("하나 이상의 scope가 필요합니다.");
      const now = Math.floor(Date.now() / 1000);
      const sessionId = randomUUID();
      const pending: PendingAuthorization = {
        sessionId,
        clientId: input.oauth.clientId,
        redirectUri: input.oauth.redirectUri,
        resource: input.resourceUrl,
        ...(typeof request.query.state === "string" ? { state: request.query.state } : {}),
        scopes,
        codeChallenge,
        csrfToken: generateOpaqueToken(24),
        authenticated: false,
        createdAt: now,
        expiresAt: now + input.oauth.loginSessionTtlSeconds,
      };
      if (pending.state && Buffer.byteLength(pending.state, "utf8") > 2_048) {
        throw new Error("state는 2,048 bytes 이하여야 합니다.");
      }
      sessions.set(sessionId, pending);
      const cookie: OAuthSessionCookiePayload = {
        subject: "pending-owner",
        clientId: input.oauth.clientId,
        sessionId,
        issuedAt: now,
        expiresAt: pending.expiresAt,
      };
      response.setHeader("Set-Cookie", service.buildSignedOAuthSessionCookie(cookie, {
        cookieName,
        path: "/oauth/authorize",
        secure: secureCookie,
        maxAgeSeconds: input.oauth.loginSessionTtlSeconds,
      }));
      response.type("html").send(ownerPage({
        title: "ChatGPT 앱 연결",
        clientName: input.oauth.clientName,
        scopes,
        csrf: pending.csrfToken,
        authenticated: false,
      }));
    } catch (error) {
      oauthError(response, 400, "invalid_request", error instanceof Error ? error.message : "인가 요청이 올바르지 않습니다.");
    }
  });
  router.post("/oauth/authorize", async (request, response) => {
    setNoStore(response);
    const cookie = service.readSignedOAuthSessionCookie(request.headers.cookie, cookieName);
    const pending = cookie ? sessions.get(cookie.sessionId) : undefined;
    if (!pending || pending.expiresAt <= Math.floor(Date.now() / 1000)
      || cookie?.clientId !== input.oauth.clientId || stringField(request, "csrf") !== pending.csrfToken) {
      oauthError(response, 400, "invalid_request", "OAuth 세션이 만료되었거나 CSRF 검증에 실패했습니다.");
      return;
    }
    const action = stringField(request, "action");
    if (action === "login") {
      const ip = requestIp(request);
      const now = Date.now();
      const previous = attempts.get(ip);
      const state = previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + 15 * 60_000 };
      if (state.count >= 5) {
        response.setHeader("Retry-After", String(Math.max(1, Math.ceil((state.resetAt - now) / 1000))));
        response.status(429).type("html").send(ownerPage({
          title: "ChatGPT 앱 연결",
          clientName: input.oauth.clientName,
          scopes: pending.scopes,
          csrf: pending.csrfToken,
          authenticated: false,
          error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        }));
        return;
      }
      if (!passwordsMatch(stringField(request, "password"), input.dashboardPassword)) {
        state.count += 1;
        attempts.set(ip, state);
        response.status(401).type("html").send(ownerPage({
          title: "ChatGPT 앱 연결",
          clientName: input.oauth.clientName,
          scopes: pending.scopes,
          csrf: pending.csrfToken,
          authenticated: false,
          error: "비밀번호가 올바르지 않습니다.",
        }));
        return;
      }
      attempts.delete(ip);
      pending.authenticated = true;
      pending.csrfToken = generateOpaqueToken(24);
      if (!input.oauth.autoApprove) {
        response.type("html").send(ownerPage({
          title: "권한 승인",
          clientName: input.oauth.clientName,
          scopes: pending.scopes,
          csrf: pending.csrfToken,
          authenticated: true,
        }));
        return;
      }
      sessions.delete(pending.sessionId);
      await approve(pending, response);
      return;
    }
    if (!pending.authenticated) {
      oauthError(response, 401, "access_denied", "소유자 로그인이 필요합니다.");
      return;
    }
    if (action === "deny") {
      sessions.delete(pending.sessionId);
      response.redirect(302, authorizationRedirect(pending, { error: "access_denied" }));
      return;
    }
    if (action !== "approve") {
      oauthError(response, 400, "invalid_request", "승인 또는 거부를 선택해 주세요.");
      return;
    }
    sessions.delete(pending.sessionId);
    await approve(pending, response);
  });

  async function approve(pending: PendingAuthorization, response: Response): Promise<void> {
    try {
      const code = generateOpaqueToken(32);
      const now = Math.floor(Date.now() / 1000);
      await repository.createAuthorizationCode({
        clientId: pending.clientId,
        subject: "owner",
        redirectUri: pending.redirectUri,
        scope: pending.scopes.join(" "),
        code,
        codeChallenge: pending.codeChallenge,
        codeChallengeMethod: "S256",
        expiresAt: now + input.oauth.authorizationCodeTtlSeconds,
        resource: pending.resource,
      });
      await repository.upsertConsent({
        clientId: pending.clientId,
        subject: "owner",
        scope: pending.scopes.join(" "),
        grantedAt: now,
        expiresAt: now + input.oauth.refreshTokenTtlSeconds,
      });
      response.redirect(302, authorizationRedirect(pending, { code }));
    } catch {
      oauthError(response, 500, "server_error", "인가 코드를 생성하지 못했습니다.");
    }
  }

  router.post("/oauth/token", async (request, response) => {
    setNoStore(response);
    if (stringField(request, "client_id") !== input.oauth.clientId
      || !service.verifyClientSecret(stringField(request, "client_secret"))) {
      oauthError(response, 401, "invalid_client", "OAuth client 인증에 실패했습니다.");
      return;
    }
    if (stringField(request, "resource") !== input.resourceUrl) {
      oauthError(response, 400, "invalid_target", "resource가 MCP resource URL과 일치해야 합니다.");
      return;
    }
    try {
      const grantType = stringField(request, "grant_type");
      let subject: string;
      let scopes: McpScopeId[];
      let refreshToken: string;
      if (grantType === "authorization_code") {
        const verifierValue = stringField(request, "code_verifier");
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifierValue)) throw new OAuthRepositoryError("invalid verifier", "auth-code-binding-invalid");
        const authorization = await repository.consumeAuthorizationCode({
          code: stringField(request, "code"),
          clientId: input.oauth.clientId,
          redirectUri: stringField(request, "redirect_uri"),
          resource: input.resourceUrl,
          codeVerifier: verifierValue,
        });
        if (!authorization) throw new OAuthRepositoryError("authorization code invalid", "auth-code-not-found");
        subject = authorization.subject;
        scopes = validateRequestedScopes(authorization.scope);
        refreshToken = generateOpaqueToken(48);
        const now = Math.floor(Date.now() / 1000);
        await repository.createRefreshToken({
          subject,
          clientId: input.oauth.clientId,
          scope: scopes.join(" "),
          resource: input.resourceUrl,
          refreshToken,
          expiresAt: now + input.oauth.refreshTokenTtlSeconds,
        });
      } else if (grantType === "refresh_token") {
        const requestedScopeText = stringField(request, "scope");
        let requestedScopes: McpScopeId[] | undefined;
        if (requestedScopeText) {
          try {
            requestedScopes = validateRequestedScopes(requestedScopeText);
          } catch {
            oauthError(response, 400, "invalid_scope", "요청한 scope가 올바르지 않습니다.");
            return;
          }
        }
        refreshToken = generateOpaqueToken(48);
        const rotated = await repository.rotateRefreshToken({
          usedRefreshToken: stringField(request, "refresh_token"),
          rotatedRefreshToken: refreshToken,
          clientId: input.oauth.clientId,
          resource: input.resourceUrl,
          ...(requestedScopes ? { requestedScope: requestedScopes.join(" ") } : {}),
          expiresAt: Math.floor(Date.now() / 1000) + input.oauth.refreshTokenTtlSeconds,
        });
        subject = rotated.subject;
        scopes = validateRequestedScopes(rotated.scope);
      } else {
        oauthError(response, 400, "unsupported_grant_type", "지원하지 않는 grant_type입니다.");
        return;
      }
      const access = await service.issueAccessToken({
        subject,
        clientId: input.oauth.clientId,
        scope: scopes,
        expiresInSeconds: input.oauth.accessTokenTtlSeconds,
      });
      response.json({
        access_token: access.token,
        token_type: "Bearer",
        expires_in: input.oauth.accessTokenTtlSeconds,
        refresh_token: refreshToken,
        scope: scopes.join(" "),
      });
    } catch (error) {
      if (error instanceof OAuthRepositoryError && error.code === "refresh-token-scope-invalid") {
        oauthError(response, 400, "invalid_scope", "기존 승인 범위를 초과할 수 없습니다.");
        return;
      }
      if (error instanceof OAuthRepositoryError) {
        oauthError(response, 400, "invalid_grant", "인가 코드 또는 refresh token이 유효하지 않습니다.");
        return;
      }
      oauthError(response, 500, "server_error", "토큰을 발급하지 못했습니다.");
    }
  });

  router.post("/oauth/revoke", async (request, response) => {
    setNoStore(response);
    if (stringField(request, "client_id") !== input.oauth.clientId
      || !service.verifyClientSecret(stringField(request, "client_secret"))) {
      oauthError(response, 401, "invalid_client", "OAuth client 인증에 실패했습니다.");
      return;
    }
    const token = stringField(request, "token");
    if (!token) {
      oauthError(response, 400, "invalid_request", "token이 필요합니다.");
      return;
    }
    try {
      if (await repository.getRefreshToken(token)) {
        await repository.revokeRefreshToken(token, input.oauth.clientId);
      } else {
        const auth = await verifier.verifyAccessToken(token);
        const claims = decodeJwt(token);
        if (typeof claims.jti === "string" && typeof claims.exp === "number") {
          await repository.revokeAccessTokenJti({
            type: "access_jti",
            identifier: claims.jti,
            clientId: auth.clientId,
            subject: typeof claims.sub === "string" ? claims.sub : undefined,
            expiresAt: claims.exp,
            reason: "access token revoked by client",
          });
        }
      }
    } catch (error) {
      if (!(error instanceof InvalidTokenError)) {
        oauthError(response, 503, "temporarily_unavailable", "토큰 폐기 상태를 저장하지 못했습니다.");
        return;
      }
      // RFC 7009 avoids revealing whether an access token existed.
    }
    response.status(200).end();
  });

  const cleanup = async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
    const nowMs = Date.now();
    for (const [key, attempt] of attempts) if (attempt.resetAt <= nowMs) attempts.delete(key);
    for (const [key, bucket] of requestBuckets) if (bucket.resetAt <= nowMs) requestBuckets.delete(key);
    await repository.cleanupExpired(now);
  };
  return { router, repository, service, verifier, cleanup };
}
