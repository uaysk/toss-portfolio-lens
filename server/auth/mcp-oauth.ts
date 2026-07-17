import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  SignJWT,
  exportJWK,
  type CryptoKey,
  type JWK,
  type KeyObject,
  type JSONWebKeySet,
} from "jose";

export type McpOAuthScope = string;

export type McpOAuthJwtClaims = {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
};

export type McpOAuthJwtHeaders = {
  kid?: string;
  typ?: string;
  alg?: "RS256";
};

export type OAuthSessionCookiePayload = {
  subject: string;
  clientId: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
};

export type OAuthSessionCookieOptions = {
  cookieName?: string;
  maxAgeSeconds?: number;
  path?: string;
  secure?: boolean;
};

export interface McpOAuthSignerConfig {
  privateKey: CryptoKey | KeyObject | Uint8Array;
  issuer: string;
  audience: string;
  keyId: string;
  clientSecret: string;
  sessionSigningSecret: string;
  expectedClientId?: string;
}

export interface OAuthAccessTokenInput {
  subject: string;
  clientId: string;
  scope: readonly string[];
  issuedAt?: number;
  notBeforeAt?: number;
  expiresInSeconds: number;
  tokenId?: string;
  headers?: McpOAuthJwtHeaders;
}

export type OAuthAccessTokenOutput = {
  token: string;
  claims: McpOAuthJwtClaims;
};

export interface SignedCookieOptions {
  cookieName?: string;
  secure?: boolean;
  path?: string;
  maxAgeSeconds?: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function buildPkceCodeChallenge(codeVerifier: string): string {
  return sha256Base64Url(codeVerifier);
}

export function verifyPkceS256(codeVerifier: string, expectedChallenge: string): boolean {
  return constantTimeEquals(buildPkceCodeChallenge(codeVerifier), expectedChallenge);
}

export function parseScope(scope: string | undefined): string[] {
  return scope?.split(/\s+/).filter(Boolean) ?? [];
}

export function formatScope(scopes: readonly string[]): string {
  return scopes.map((scope) => scope.trim()).filter(Boolean).join(" ");
}

export function generateOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

export function makeCookieValue(payload: object): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function parseCookieValue<T>(value: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

export class McpOAuthService {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly keyId: string;
  private readonly privateKey: CryptoKey | KeyObject | Uint8Array;
  private readonly expectedClientId?: string;
  private readonly clientSecret: string;
  private readonly sessionSigningSecret: string;
  private jwksCache?: Promise<JSONWebKeySet>;

  constructor(config: McpOAuthSignerConfig) {
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.keyId = config.keyId;
    this.privateKey = config.privateKey;
    this.clientSecret = config.clientSecret;
    this.sessionSigningSecret = config.sessionSigningSecret;
    this.expectedClientId = config.expectedClientId;
  }

  private async buildPublicJwk(): Promise<JWK> {
    const privateOrPublicJwk = await exportJWK(this.privateKey);
    if (
      typeof privateOrPublicJwk.kty !== "string" ||
      typeof privateOrPublicJwk.n !== "string" ||
      typeof privateOrPublicJwk.e !== "string"
    ) {
      throw new Error("공개 RSA 키 구성에 필요한 kty/n/e 값이 없습니다.");
    }
    return {
      kty: privateOrPublicJwk.kty,
      kid: privateOrPublicJwk.kid ?? this.keyId,
      alg: "RS256",
      use: "sig",
      key_ops: ["verify"],
      n: privateOrPublicJwk.n,
      e: privateOrPublicJwk.e,
    };
  }

  async exportJwks(): Promise<JSONWebKeySet> {
    if (!this.jwksCache) {
      this.jwksCache = (async () => ({
        keys: [await this.buildPublicJwk()],
      }))();
    }
    return this.jwksCache;
  }

  async issueAccessToken(input: OAuthAccessTokenInput): Promise<OAuthAccessTokenOutput> {
    const issuedAt = input.issuedAt ?? nowSeconds();
    const notBeforeAt = input.notBeforeAt ?? issuedAt;
    const expiresInSeconds = input.expiresInSeconds;
    const clientId = input.clientId.trim();
    const scope = formatScope(input.scope);
    const jti = input.tokenId ?? generateOpaqueToken();

    if (!clientId) {
      throw new Error("client_id가 비어 있습니다.");
    }
    if (this.expectedClientId !== undefined && this.expectedClientId !== clientId) {
      throw new Error("요청한 client_id가 허용된 값과 일치하지 않습니다.");
    }
    if (!isPositiveInteger(expiresInSeconds)) {
      throw new Error("expiresInSeconds는 1 이상 정수여야 합니다.");
    }
    if (notBeforeAt < issuedAt) {
      throw new Error("nbf는 iat보다 빠를 수 없습니다.");
    }

    const expiresAt = issuedAt + expiresInSeconds;

    const token = await new SignJWT({
      client_id: clientId,
      scope,
      jti,
      iss: this.issuer,
      aud: this.audience,
      sub: input.subject,
    })
      .setProtectedHeader({
        ...input.headers,
        alg: "RS256",
        typ: input.headers?.typ ?? "JWT",
        kid: input.headers?.kid ?? this.keyId,
      })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(input.subject)
      .setIssuedAt(issuedAt)
      .setNotBefore(notBeforeAt)
      .setExpirationTime(expiresAt)
      .setJti(jti)
      .sign(this.privateKey);

    return {
      token,
      claims: {
        iss: this.issuer,
        aud: this.audience,
        sub: input.subject,
        client_id: clientId,
        scope,
        iat: issuedAt,
        nbf: notBeforeAt,
        exp: expiresAt,
        jti,
      },
    };
  }

  buildSignedOAuthSessionCookie(
    payload: OAuthSessionCookiePayload,
    options: SignedCookieOptions = {},
  ): string {
    const now = nowSeconds();
    const issuedAt = isPositiveInteger(payload.issuedAt) && payload.issuedAt > 0 ? payload.issuedAt : now;
    const baseExpiresAt = isPositiveInteger(payload.expiresAt) && payload.expiresAt > 0 ? payload.expiresAt : undefined;
    const requestedMaxAge = options.maxAgeSeconds;
    const derivedMaxAge = baseExpiresAt == null ? undefined : Math.max(0, Math.trunc(baseExpiresAt - now));
    const maxAgeSeconds = isPositiveInteger(requestedMaxAge ?? 0) ? requestedMaxAge : derivedMaxAge;

    if (!maxAgeSeconds) {
      throw new Error("쿠키 만료 설정이 유효하지 않습니다.");
    }

    const finalPayload: OAuthSessionCookiePayload = {
      ...payload,
      issuedAt,
      expiresAt: baseExpiresAt ?? issuedAt + maxAgeSeconds,
    };

    if (finalPayload.expiresAt <= finalPayload.issuedAt || finalPayload.issuedAt > now) {
      throw new Error("쿠키 issuedAt/expiresAt 값이 유효하지 않습니다.");
    }

    const encoded = makeCookieValue(finalPayload);
    const signature = createHmac("sha256", this.sessionSigningSecret).update(encoded).digest("base64url");
    const cookieName = options.cookieName ?? "mcp_oauth_session";
    const path = options.path ?? "/";
    const secure = options.secure === false ? "" : "; Secure";
    return `${cookieName}=${encoded}.${signature}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
  }

  readSignedOAuthSessionCookie(
    cookieHeader: string | undefined,
    cookieName = "mcp_oauth_session",
    now = nowSeconds(),
  ): OAuthSessionCookiePayload | undefined {
    if (!cookieHeader) return undefined;
    const target = cookieHeader
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!target) return undefined;

    const [encoded, signature] = target.split(".");
    if (!encoded || !signature) return undefined;
    const expected = createHmac("sha256", this.sessionSigningSecret).update(encoded).digest("base64url");
    if (!constantTimeEquals(signature, expected)) return undefined;

    const payload = parseCookieValue<OAuthSessionCookiePayload>(encoded);
    if (!payload || typeof payload !== "object") return undefined;
    if (typeof payload.issuedAt !== "number" || !Number.isInteger(payload.issuedAt) || payload.issuedAt <= 0) {
      return undefined;
    }
    if (typeof payload.expiresAt !== "number" || !Number.isInteger(payload.expiresAt) || payload.expiresAt <= now) {
      return undefined;
    }
    if (payload.issuedAt > payload.expiresAt || payload.issuedAt > now) {
      return undefined;
    }
    if (
      typeof payload.subject !== "string" ||
      typeof payload.clientId !== "string" ||
      typeof payload.sessionId !== "string"
    ) {
      return undefined;
    }

    return payload;
  }

  verifyClientSecret(secret: string): boolean {
    return constantTimeEquals(this.clientSecret, secret);
  }
}
