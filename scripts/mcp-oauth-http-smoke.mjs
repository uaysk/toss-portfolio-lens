import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createLocalJWKSet, jwtVerify } from "jose";

const baseUrl = required("MCP_SMOKE_BASE_URL").replace(/\/+$/, "");
const resource = required("MCP_RESOURCE_URL");
const clientId = required("MCP_OAUTH_CLIENT_ID");
const redirectUri = required("MCP_OAUTH_REDIRECT_URI");
const password = required("DASHBOARD_PASSWORD");
const clientSecret = (await readFile(
  process.env.MCP_OAUTH_CLIENT_SECRET_FILE || "/run/secrets/mcp-oauth-client-secret",
  "utf8",
)).trim();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function form(values) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined));
}

function csrf(html) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  if (!match) throw new Error("OAuth page did not contain a CSRF token");
  return match[1];
}

function authorizationSession(html) {
  const match = html.match(/name="authorization_session" value="([^"]+)"/);
  if (!match) throw new Error("OAuth page did not contain an authorization session");
  return match[1];
}

function cookie(response) {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("OAuth authorize response did not set a session cookie");
  return value.split(";", 1)[0];
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function authorize(scope = "backtest:run") {
  const pair = pkce();
  const state = randomBytes(18).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
    scope,
    state,
    code_challenge: pair.challenge,
    code_challenge_method: "S256",
  });
  const loginPage = await fetch(`${baseUrl}/oauth/authorize?${query}`, { redirect: "manual" });
  assert(loginPage.status === 200, `authorize page returned ${loginPage.status}`);
  const ownerCookie = cookie(loginPage);
  const loginHtml = await loginPage.text();
  assert(loginHtml.includes("Toss Portfolio Lens"), "authorize page omitted the app name");
  assert(loginHtml.includes("대시보드 비밀번호"), "authorize page omitted the password field");

  const login = await fetch(`${baseUrl}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: ownerCookie },
    body: form({
      csrf: csrf(loginHtml),
      authorization_session: authorizationSession(loginHtml),
      action: "login",
      password,
    }),
  });
  assert(login.status === 200, `owner login returned ${login.status}`);
  const approvalHtml = await login.text();
  assert(approvalHtml.includes("허용") && approvalHtml.includes("거부"), "approval controls were not rendered");
  assert(approvalHtml.includes("권한 승인"), "approval title was not rendered");

  const approval = await fetch(`${baseUrl}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: ownerCookie },
    body: form({
      csrf: csrf(approvalHtml),
      authorization_session: authorizationSession(approvalHtml),
      action: "approve",
    }),
  });
  assert(approval.status === 302, `approval returned ${approval.status}`);
  const location = approval.headers.get("location");
  assert(location, "approval omitted redirect location");
  const callback = new URL(location);
  assert(callback.origin + callback.pathname === new URL(redirectUri).origin + new URL(redirectUri).pathname, "redirect URI changed");
  assert(callback.searchParams.get("state") === state, "OAuth state was not preserved");
  const code = callback.searchParams.get("code");
  assert(code, "approval omitted authorization code");
  return { code, verifier: pair.verifier, scope };
}

async function token(values, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ client_id: clientId, client_secret: clientSecret, resource, ...values }),
  });
  assert(response.status === expectedStatus, `token endpoint returned ${response.status}, expected ${expectedStatus}`);
  return response.json();
}

async function mcp(accessToken, body, sessionId) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    payload = JSON.parse(data.at(-1).slice(5).trim());
  } else {
    payload = text ? JSON.parse(text) : undefined;
  }
  return { response, payload, sessionId: response.headers.get("mcp-session-id") || sessionId };
}

const protectedMetadataResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
assert(protectedMetadataResponse.status === 200, "protected resource metadata failed");
const protectedMetadata = await protectedMetadataResponse.json();
assert(protectedMetadata.resource === resource, "protected resource metadata has the wrong resource");

const authorizationMetadataResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
assert(authorizationMetadataResponse.status === 200, "authorization server metadata failed");
const authorizationMetadata = await authorizationMetadataResponse.json();
assert(authorizationMetadata.code_challenge_methods_supported?.includes("S256"), "metadata omitted PKCE S256");
assert(authorizationMetadata.token_endpoint_auth_methods_supported?.includes("client_secret_post"), "metadata omitted client_secret_post");

const jwksResponse = await fetch(`${baseUrl}/oauth/jwks.json`);
assert(jwksResponse.status === 200, "JWKS failed");
const jwks = await jwksResponse.json();
assert(Array.isArray(jwks.keys) && jwks.keys.length > 0, "JWKS contained no keys");

const grant = await authorize();
const issued = await token({
  grant_type: "authorization_code",
  code: grant.code,
  redirect_uri: redirectUri,
  code_verifier: grant.verifier,
});
assert(issued.access_token && issued.refresh_token, "token response omitted tokens");
const verified = await jwtVerify(issued.access_token, createLocalJWKSet(jwks), {
  issuer: authorizationMetadata.issuer,
  audience: resource,
  algorithms: ["RS256"],
});
assert(verified.payload.scope === "backtest:run", "JWT scope mismatch");
assert(verified.payload.client_id === clientId, "JWT client_id mismatch");

let rpc = await mcp(issued.access_token, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "oauth-smoke", version: "1" } },
});
assert(rpc.response.status === 200 && rpc.payload?.result?.serverInfo?.name === "Toss Portfolio Lens", "MCP initialize failed");
assert(rpc.sessionId, "stateful MCP initialize omitted a session ID");

rpc = await mcp(issued.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, rpc.sessionId);
assert(rpc.payload?.result?.tools?.length === 30, "tools/list did not return exactly 30 tools");

rpc = await mcp(issued.access_token, {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "analyze_rebalance_plan",
    arguments: {
      currentWeights: { AAA: 0.6, BBB: 0.4 },
      targetWeights: { AAA: 0.5, BBB: 0.5 },
      transactionCostBps: 10,
    },
  },
}, rpc.sessionId);
assert(!rpc.payload?.result?.isError, "valid MCP tool call failed");

rpc = await mcp(issued.access_token, {
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "generate_backtest_report", arguments: { runId: "00000000-0000-4000-8000-000000000000" } },
}, rpc.sessionId);
assert(rpc.payload?.result?.isError === true, "insufficient scope tool call was not rejected");
assert(rpc.payload?.result?._meta?.["mcp/www_authenticate"], "insufficient scope challenge metadata was omitted");

const rotated = await token({ grant_type: "refresh_token", refresh_token: issued.refresh_token });
assert(rotated.refresh_token && rotated.refresh_token !== issued.refresh_token, "refresh token was not rotated");
await token({ grant_type: "refresh_token", refresh_token: issued.refresh_token }, 400);
await token({ grant_type: "refresh_token", refresh_token: rotated.refresh_token }, 400);

const mismatchGrant = await authorize();
const mismatchResponse = await fetch(`${baseUrl}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: form({
    client_id: clientId,
    client_secret: clientSecret,
    resource: `${resource}-wrong`,
    grant_type: "authorization_code",
    code: mismatchGrant.code,
    redirect_uri: redirectUri,
    code_verifier: mismatchGrant.verifier,
  }),
});
assert(mismatchResponse.status === 400, "resource mismatch was not rejected");

const invalidRedirect = new URL(`${baseUrl}/oauth/authorize`);
invalidRedirect.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: `${redirectUri}/wrong`,
  resource,
  scope: "backtest:run",
  code_challenge: pkce().challenge,
  code_challenge_method: "S256",
}).toString();
assert((await fetch(invalidRedirect, { redirect: "manual" })).status === 400, "redirect URI mismatch was not rejected");

const revoke = await fetch(`${baseUrl}/oauth/revoke`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: form({ client_id: clientId, client_secret: clientSecret, token: rotated.access_token, token_type_hint: "refresh_token" }),
});
assert(revoke.status === 200, "access token revocation failed");
const revokedCall = await mcp(rotated.access_token, { jsonrpc: "2.0", id: 5, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "revoked", version: "1" } } });
assert(revokedCall.response.status === 401, "revoked access token was accepted");

console.info("MCP OAuth HTTP smoke passed: metadata, PKCE, JWT, MCP, scopes, rotation, reuse detection and revocation.");
