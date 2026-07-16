import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

const COOKIE_NAME = "portfolio_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

type SessionPayload = {
  exp: number;
  iat: number;
  version: 1;
};

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return header.split(";").reduce<Record<string, string>>((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator === -1) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = value;
    return cookies;
  }, {});
}

function secureRequest(request: Request, forceSecure: boolean): boolean {
  return forceSecure || request.secure;
}

export function passwordsMatch(input: string, expected: string): boolean {
  const inputHash = createHash("sha256").update(input).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(inputHash, expectedHash);
}

export function createSessionCookie(request: Request, secret: string, forceSecure = false): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    version: 1,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const value = encoded + "." + sign(encoded, secret);
  const secure = secureRequest(request, forceSecure) ? "; Secure" : "";
  return COOKIE_NAME + "=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + SESSION_TTL_SECONDS + secure;
}

export function clearSessionCookie(request: Request, forceSecure = false): string {
  const secure = secureRequest(request, forceSecure) ? "; Secure" : "";
  return COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + secure;
}

function readSignedPayload(value: string, secret: string): unknown {
  const [encoded, providedSignature, ...rest] = value.split(".");
  if (!encoded || !providedSignature || rest.length > 0) return undefined;

  const expectedSignature = sign(encoded, secret);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;

  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function hasValidSession(request: Request, secret: string): boolean {
  const value = parseCookies(request.headers.cookie)[COOKIE_NAME];
  if (!value) return false;
  const payload = readSignedPayload(value, secret) as Partial<SessionPayload> | undefined;
  const now = Math.floor(Date.now() / 1000);
  return payload?.version === 1 && typeof payload.exp === "number" && payload.exp > now;
}

export function hasValidReadOnlyApiSecret(authorization: string | undefined, dashboardPassword: string): boolean {
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return false;
  return passwordsMatch(match[1], dashboardPassword);
}

export function setNoStore(response: Response): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
}
