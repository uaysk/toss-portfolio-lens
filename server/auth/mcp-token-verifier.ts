import {
  jwtVerify,
  type CryptoKey,
  type JWK,
  type KeyObject,
} from "jose";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { McpOAuthJwtClaims } from "./mcp-oauth.js";
import { parseScope } from "./mcp-oauth.js";
import { OAuthRepository } from "../repositories/oauth-repository.js";

export type McpTokenVerifierKey = CryptoKey | KeyObject | JWK | Uint8Array;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export interface McpTokenVerifierConfig {
  issuer: string;
  audience: string;
  key: McpTokenVerifierKey;
  repository: OAuthRepository;
  clockTolerance?: string | number;
  expectedClientId?: string;
}

export function assertJwtString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export class McpTokenVerifier implements OAuthTokenVerifier {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly key: McpTokenVerifierKey;
  private readonly repository: OAuthRepository;
  private readonly clockTolerance?: string | number;
  private readonly expectedClientId?: string;

  constructor(config: McpTokenVerifierConfig) {
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.key = config.key;
    this.repository = config.repository;
    this.clockTolerance = config.clockTolerance;
    this.expectedClientId = config.expectedClientId;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      return await this.verify(token);
    } catch (error) {
      if (error instanceof InvalidTokenError || error instanceof ServerError) throw error;
      throw new InvalidTokenError("Access token is invalid or expired");
    }
  }

  private async verify(token: string): Promise<AuthInfo> {
    const result = await jwtVerify(token, this.key, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ["RS256"],
        clockTolerance: this.clockTolerance,
      });

    if (result.protectedHeader.alg !== "RS256") {
      throw new InvalidTokenError("Access token algorithm is invalid");
    }

    const payload = result.payload as unknown as Partial<McpOAuthJwtClaims> & {
      aud?: string | string[];
    };

    if (!assertJwtString(payload.iss) || payload.iss !== this.issuer) {
      throw new InvalidTokenError("Access token issuer is invalid");
    }

    const expectedAudience = this.audience;
    const aud = payload.aud;
    if (!payload.aud) {
      throw new InvalidTokenError("Access token audience is missing");
    }
    if (Array.isArray(aud)) {
      if (!aud.includes(expectedAudience)) {
        throw new InvalidTokenError("Access token audience is invalid");
      }
    } else if (aud !== expectedAudience) {
      throw new InvalidTokenError("Access token audience is invalid");
    }

    if (!assertJwtString(payload.sub)) {
      throw new InvalidTokenError("Access token subject is missing");
    }
    if (!assertJwtString(payload.client_id)) {
      throw new InvalidTokenError("Access token client_id is missing");
    }
    if (this.expectedClientId !== undefined && payload.client_id !== this.expectedClientId) {
      throw new InvalidTokenError("Access token client_id is invalid");
    }
    if (!assertJwtString(payload.jti)) {
      throw new InvalidTokenError("Access token jti is missing");
    }
    if (!assertJwtString(payload.scope)) {
      throw new InvalidTokenError("Access token scope is missing");
    }
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
      throw new InvalidTokenError("Access token iat is missing");
    }
    if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)) {
      throw new InvalidTokenError("Access token nbf is missing");
    }
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      throw new InvalidTokenError("Access token exp is missing");
    }
    if (payload.nbf > nowSeconds() + 300) {
      throw new InvalidTokenError("Access token is not active");
    }
    let revoked: boolean;
    try {
      revoked = await this.repository.isAccessTokenRevoked(payload.jti, nowSeconds());
    } catch {
      throw new ServerError("Token revocation state is unavailable");
    }
    if (revoked) {
      throw new InvalidTokenError("Access token is revoked");
    }

    return {
      token,
      clientId: payload.client_id,
      scopes: parseScope(payload.scope),
      expiresAt: payload.exp,
      resource: new URL(this.audience),
      extra: {
        iss: payload.iss,
        aud: payload.aud,
        sub: payload.sub,
        client_id: payload.client_id,
        jti: payload.jti,
      },
    };
  }
}
