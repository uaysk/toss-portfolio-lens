import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RelationalDatabase } from "../database.js";

export type RevocationType = "access_jti" | "refresh_family";

export interface OAuthAuthorizationCodeInput {
  clientId: string;
  subject: string;
  redirectUri: string;
  scope: string;
  code: string;
  codeChallenge: string;
  codeChallengeMethod?: "S256";
  expiresAt: number;
  resource: string;
}

export interface OAuthAuthorizationCodeRecord {
  clientId: string;
  subject: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
}

export interface OAuthAuthorizationCodeConsumeInput {
  code: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeVerifier: string;
}

export interface OAuthRefreshTokenInput {
  subject: string;
  clientId: string;
  scope: string;
  resource: string;
  refreshToken: string;
  expiresAt: number;
  familyId?: string;
  issuedAt?: number;
  previousRefreshToken?: string | null;
}

export interface OAuthRefreshTokenRecord {
  tokenHash: string;
  familyId: string;
  subject: string;
  clientId: string;
  scope: string;
  resource: string;
  issuedAt: number;
  expiresAt: number;
  previousTokenHash?: string;
  replacedByHash?: string;
  revokedAt?: number;
}

export interface OAuthRefreshTokenRotationInput {
  usedRefreshToken: string;
  rotatedRefreshToken: string;
  clientId: string;
  resource: string;
  requestedScope?: string;
  expiresAt: number;
  issuedAt?: number;
}

export interface OAuthConsentInput {
  clientId: string;
  subject: string;
  scope: string;
  expiresAt: number;
  grantedAt?: number;
}

export interface OAuthConsentRecord {
  clientId: string;
  subject: string;
  scope: string;
  grantedAt: number;
  expiresAt: number;
}

export interface OAuthRevocationInput {
  type: RevocationType;
  identifier: string;
  clientId: string;
  subject?: string;
  familyId?: string;
  reason?: string;
  revokedAt?: number;
  expiresAt?: number;
}

export interface OAuthCleanupResult {
  authorizationCodesDeleted: number;
  refreshTokensDeleted: number;
  revocationsDeleted: number;
  consentsDeleted: number;
}

export type OAuthRepositoryErrorCode =
  | "auth-code-not-found"
  | "auth-code-consumed"
  | "auth-code-binding-invalid"
  | "refresh-token-expired"
  | "refresh-token-revoked"
  | "refresh-token-reused"
  | "refresh-token-family-revoked"
  | "refresh-token-binding-invalid"
  | "refresh-token-scope-invalid";

export class OAuthRepositoryError extends Error {
  constructor(
    message: string,
    readonly code: OAuthRepositoryErrorCode,
  ) {
    super(message);
  }
}

type AnyRow = Record<string, unknown>;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function hashEquals(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function generateFamilyId(): string {
  return randomBytes(32).toString("base64url");
}

function rowValue<T extends string | number | null | undefined>(value: unknown, _default: T): T {
  if (value == null) return _default;
  if (typeof value === "string" || typeof value === "number") return value as T;
  return _default;
}

function rowString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} should be a non-empty string.`);
  }
  return value;
}

function isPositiveTimestamp(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function mapAuthorizationCode(row: AnyRow): OAuthAuthorizationCodeRecord {
  return {
    clientId: String(row.client_id),
    subject: String(row.subject),
    redirectUri: String(row.redirect_uri),
    scope: String(row.scope),
    codeChallenge: String(row.code_challenge),
    codeChallengeMethod: String(row.code_challenge_method),
    resource: rowString(row.resource, "resource"),
  };
}

function mapRefreshToken(row: AnyRow): OAuthRefreshTokenRecord {
  return {
    tokenHash: String(row.token_hash),
    familyId: String(row.family_id),
    subject: String(row.subject),
    clientId: String(row.client_id),
    scope: String(row.scope),
    resource: typeof row.resource === "string" ? row.resource : "",
    issuedAt: Number(row.issued_at),
    expiresAt: Number(row.expires_at),
    previousTokenHash: row.previous_token_hash != null ? String(row.previous_token_hash) : undefined,
    replacedByHash: row.replaced_by_hash != null ? String(row.replaced_by_hash) : undefined,
    revokedAt: row.revoked_at == null ? undefined : Number(row.revoked_at),
  };
}

function mapConsent(row: AnyRow): OAuthConsentRecord {
  return {
    clientId: String(row.client_id),
    subject: String(row.subject),
    scope: String(row.scope),
    grantedAt: Number(row.granted_at),
    expiresAt: Number(row.expires_at),
  };
}

export class OAuthRepository {
  constructor(private readonly database: RelationalDatabase) {}

  async ensureSchema(): Promise<void> {
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        CREATE TABLE IF NOT EXISTS mcp_oauth_authorization_codes (
          code_hash VARCHAR(64) PRIMARY KEY,
          client_id VARCHAR(128) NOT NULL,
          subject VARCHAR(128) NOT NULL,
          redirect_uri VARCHAR(2048) NOT NULL,
          scope VARCHAR(512) NOT NULL,
          code_challenge VARCHAR(128) NOT NULL,
          code_challenge_method VARCHAR(16) NOT NULL,
          resource VARCHAR(2048) NOT NULL,
          expires_at BIGINT NOT NULL,
          created_at BIGINT NOT NULL,
          used_at BIGINT NULL,
          KEY idx_mcp_oauth_authorization_codes_expires_at (expires_at),
          KEY idx_mcp_oauth_authorization_codes_client_subject (client_id, subject)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await this.database.run(`
        CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
          token_hash VARCHAR(64) PRIMARY KEY,
          family_id VARCHAR(64) NOT NULL,
          client_id VARCHAR(128) NOT NULL,
          subject VARCHAR(128) NOT NULL,
          scope VARCHAR(512) NOT NULL,
          resource VARCHAR(2048) NOT NULL,
          issued_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          previous_token_hash VARCHAR(64) NULL,
          replaced_by_hash VARCHAR(64) NULL,
          revoked_at BIGINT NULL,
          KEY idx_mcp_oauth_refresh_tokens_family_id (family_id),
          KEY idx_mcp_oauth_refresh_tokens_subject (subject),
          KEY idx_mcp_oauth_refresh_tokens_expires_at (expires_at),
          KEY idx_mcp_oauth_refresh_tokens_revoked_at (revoked_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await this.database.run(`
        CREATE TABLE IF NOT EXISTS mcp_oauth_revocations (
          revocation_type VARCHAR(32) NOT NULL,
          identifier VARCHAR(128) NOT NULL,
          client_id VARCHAR(128) NOT NULL,
          subject VARCHAR(128) NULL,
          family_id VARCHAR(64) NULL,
          reason VARCHAR(255) NULL,
          revoked_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          PRIMARY KEY (revocation_type, identifier),
          KEY idx_mcp_oauth_revocations_expires_at (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await this.database.run(`
        CREATE TABLE IF NOT EXISTS mcp_oauth_consents (
          client_id VARCHAR(128) NOT NULL,
          subject VARCHAR(128) NOT NULL,
          scope VARCHAR(512) NOT NULL,
          granted_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          PRIMARY KEY (client_id, subject),
          KEY idx_mcp_oauth_consents_expires_at (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await this.ensureRefreshResourceColumn();
      return;
    }
    const integer = this.database.dialect === "postgres" ? "BIGINT" : "INTEGER";
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_authorization_codes (
        code_hash TEXT NOT NULL PRIMARY KEY,
        client_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at ${integer} NOT NULL,
        created_at ${integer} NOT NULL,
        used_at ${integer}
      )
    `);
    await this.database.run("CREATE INDEX IF NOT EXISTS idx_mcp_oauth_authorization_codes_expires_at ON mcp_oauth_authorization_codes(expires_at)");
    await this.database.run("CREATE INDEX IF NOT EXISTS idx_mcp_oauth_authorization_codes_client_subject ON mcp_oauth_authorization_codes(client_id, subject)");

    await this.database.run(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
        token_hash TEXT NOT NULL PRIMARY KEY,
        family_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        issued_at ${integer} NOT NULL,
        expires_at ${integer} NOT NULL,
        previous_token_hash TEXT,
        replaced_by_hash TEXT,
        revoked_at ${integer}
      )
    `);
    await this.database.run("CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_tokens_family_id ON mcp_oauth_refresh_tokens(family_id)");
    await this.database.run("CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_tokens_subject ON mcp_oauth_refresh_tokens(subject)");
    await this.database.run("CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_tokens_expires_at ON mcp_oauth_refresh_tokens(expires_at)");
    await this.database.run("CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_tokens_revoked_at ON mcp_oauth_refresh_tokens(revoked_at)");

    await this.database.run(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_revocations (
        revocation_type TEXT NOT NULL,
        identifier TEXT NOT NULL,
        client_id TEXT NOT NULL,
        subject TEXT,
        family_id TEXT,
        reason TEXT,
        revoked_at ${integer} NOT NULL,
        expires_at ${integer} NOT NULL,
        PRIMARY KEY (revocation_type, identifier)
      )
    `);
    await this.database.run("CREATE INDEX IF NOT EXISTS idx_mcp_oauth_revocations_expires_at ON mcp_oauth_revocations(expires_at)");

    await this.database.run(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_consents (
        client_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        scope TEXT NOT NULL,
        granted_at ${integer} NOT NULL,
        expires_at ${integer} NOT NULL,
        PRIMARY KEY (client_id, subject)
      )
    `);
    await this.database.run("CREATE INDEX IF NOT EXISTS idx_mcp_oauth_consents_expires_at ON mcp_oauth_consents(expires_at)");
    await this.ensureRefreshResourceColumn();
  }

  private async ensureRefreshResourceColumn(): Promise<void> {
    try {
      await this.database.query("SELECT resource FROM mcp_oauth_refresh_tokens LIMIT 0");
    } catch {
      const column = this.database.dialect === "mysql" ? "VARCHAR(2048) NULL" : "TEXT";
      await this.database.run(`ALTER TABLE mcp_oauth_refresh_tokens ADD COLUMN resource ${column}`);
    }
  }

  async createAuthorizationCode(input: OAuthAuthorizationCodeInput): Promise<void> {
    const now = nowSeconds();
    const codeHash = sha256Base64Url(input.code);
    const resource = input.resource.trim();
    if (!resource) {
      throw new Error("authorization code resource is required.");
    }
    await this.database.run(`
      INSERT INTO mcp_oauth_authorization_codes (
        code_hash, client_id, subject, redirect_uri, scope, code_challenge, code_challenge_method,
        resource, expires_at, created_at, used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `, [
      codeHash,
      input.clientId,
      input.subject,
      input.redirectUri,
      input.scope,
      input.codeChallenge,
      input.codeChallengeMethod ?? "S256",
      resource,
      input.expiresAt,
      now,
    ]);
  }

  async consumeAuthorizationCode(
    input: OAuthAuthorizationCodeConsumeInput,
    now = nowSeconds(),
  ): Promise<OAuthAuthorizationCodeRecord | undefined> {
    const codeHash = sha256Base64Url(input.code);
    let found: OAuthAuthorizationCodeRecord | undefined;

    await this.database.transaction(async (database) => {
      const rows = await database.query<AnyRow>(`
        SELECT client_id, subject, redirect_uri, scope, code_challenge, code_challenge_method, resource
        FROM mcp_oauth_authorization_codes
        WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
      `, [codeHash, now]);
      if (rows.length === 0) return;
      const record = mapAuthorizationCode(rows[0]!);
      const expectedChallenge = sha256Base64Url(input.codeVerifier);
      if (record.clientId !== input.clientId
        || record.redirectUri !== input.redirectUri
        || record.resource !== input.resource
        || record.codeChallengeMethod !== "S256"
        || !hashEquals(record.codeChallenge, expectedChallenge)) {
        throw new OAuthRepositoryError("authorization code binding is invalid", "auth-code-binding-invalid");
      }

      const update = await database.run(`
        UPDATE mcp_oauth_authorization_codes
        SET used_at = ?
        WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
      `, [now, codeHash, now]);

      if (update.affectedRows === 1) {
        found = record;
      }
    });

    if (!found) return undefined;
    return found;
  }

  async createRefreshToken(input: OAuthRefreshTokenInput): Promise<OAuthRefreshTokenRecord> {
    const now = input.issuedAt ?? nowSeconds();
    const tokenHash = sha256Base64Url(input.refreshToken);
    const familyId = input.familyId ?? generateFamilyId();
    const previousTokenHash = input.previousRefreshToken == null ? undefined : sha256Base64Url(input.previousRefreshToken);

    if (!isPositiveTimestamp(input.expiresAt)) {
      throw new Error("refresh token expiry must be a positive timestamp.");
    }

    await this.database.run(`
      INSERT INTO mcp_oauth_refresh_tokens (
        token_hash, family_id, client_id, subject, scope, resource, issued_at, expires_at, previous_token_hash, revoked_at, replaced_by_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `, [
      tokenHash,
      familyId,
      input.clientId,
      input.subject,
      input.scope,
      input.resource,
      now,
      input.expiresAt,
      previousTokenHash,
    ]);

    return {
      tokenHash,
      familyId,
      clientId: input.clientId,
      subject: input.subject,
      scope: input.scope,
      resource: input.resource,
      issuedAt: now,
      expiresAt: input.expiresAt,
      previousTokenHash,
    };
  }

  async getRefreshToken(inputToken: string): Promise<OAuthRefreshTokenRecord | undefined> {
    const tokenHash = sha256Base64Url(inputToken);
    const rows = await this.database.query<AnyRow>(`
      SELECT token_hash, family_id, client_id, subject, scope, resource, issued_at, expires_at, previous_token_hash, revoked_at, replaced_by_hash
      FROM mcp_oauth_refresh_tokens
      WHERE token_hash = ?
      LIMIT 1
    `, [tokenHash]);
    return rows[0] ? mapRefreshToken(rows[0]!) : undefined;
  }

  async isRefreshFamilyRevoked(familyId: string, now = nowSeconds()): Promise<boolean> {
    const rows = await this.database.query<AnyRow>(`
      SELECT 1 AS found
      FROM mcp_oauth_revocations
      WHERE revocation_type = 'refresh_family' AND identifier = ? AND expires_at > ?
      LIMIT 1
    `, [familyId, now]);
    return rows.length > 0;
  }

  private async isRefreshFamilyRevokedWithDatabase(
    database: RelationalDatabase,
    familyId: string,
    now = nowSeconds(),
  ): Promise<boolean> {
    const rows = await database.query<AnyRow>(`
      SELECT 1 AS found
      FROM mcp_oauth_revocations
      WHERE revocation_type = 'refresh_family' AND identifier = ? AND expires_at > ?
      LIMIT 1
    `, [familyId, now]);
    return rows.length > 0;
  }

  async rotateRefreshToken(input: OAuthRefreshTokenRotationInput): Promise<OAuthRefreshTokenRecord> {
    const usedHash = sha256Base64Url(input.usedRefreshToken);
    const rotatedHash = sha256Base64Url(input.rotatedRefreshToken);
    const now = nowSeconds();
    const issuedAt = input.issuedAt ?? now;

    if (!isPositiveTimestamp(input.expiresAt)) {
      throw new OAuthRepositoryError("refresh token expiry must be a positive timestamp.", "refresh-token-expired");
    }

    const outcome = await this.database.transaction(async (database): Promise<
      | { record: OAuthRefreshTokenRecord }
      | { error: OAuthRepositoryErrorCode; message: string }
    > => {
      const rows = await database.query<AnyRow>(`
        SELECT token_hash, family_id, client_id, subject, scope, resource, issued_at, expires_at, previous_token_hash, replaced_by_hash, revoked_at
        FROM mcp_oauth_refresh_tokens
        WHERE token_hash = ?
        LIMIT 1
      `, [usedHash]);
      if (rows.length === 0) {
        return { error: "refresh-token-expired", message: "refresh token not found" };
      }

      const used = mapRefreshToken(rows[0]!);
      if (used.expiresAt <= now) {
        return { error: "refresh-token-expired", message: "refresh token expired" };
      }
      if (await this.isRefreshFamilyRevokedWithDatabase(database, used.familyId, now)) {
        return { error: "refresh-token-family-revoked", message: "refresh token family revoked" };
      }
      if (used.clientId !== input.clientId || used.resource !== input.resource) {
        return { error: "refresh-token-binding-invalid", message: "refresh token binding is invalid" };
      }
      const grantedScopes = new Set(used.scope.split(/\s+/).filter(Boolean));
      const requestedScopes = input.requestedScope?.split(/\s+/).filter(Boolean) ?? [...grantedScopes];
      if (requestedScopes.some((scope) => !grantedScopes.has(scope))) {
        return { error: "refresh-token-scope-invalid", message: "refresh token scope exceeds the grant" };
      }
      const nextScope = requestedScopes.join(" ");
      if (used.replacedByHash !== undefined && used.replacedByHash !== "") {
        await this.revokeRefreshFamilyWithDatabase(
          database,
          {
            familyId: used.familyId,
            clientId: used.clientId,
            subject: used.subject,
          },
          (await this.refreshFamilyMaxExpiry(database, used.familyId)) || used.expiresAt,
        );
        return { error: "refresh-token-reused", message: "refresh token already rotated" };
      }
      if (used.revokedAt != null) {
        return { error: "refresh-token-revoked", message: "refresh token revoked" };
      }

      const claimedRows = await database.run(`
        UPDATE mcp_oauth_refresh_tokens
        SET revoked_at = COALESCE(revoked_at, ?), replaced_by_hash = ?
        WHERE token_hash = ?
          AND revoked_at IS NULL
          AND replaced_by_hash IS NULL
          AND expires_at > ?
      `, [now, rotatedHash, usedHash, now]);

      if (claimedRows.affectedRows !== 1) {
        const currentRows = await database.query<AnyRow>(`
          SELECT token_hash, family_id, client_id, subject, scope, resource, issued_at, expires_at, previous_token_hash, revoked_at, replaced_by_hash
          FROM mcp_oauth_refresh_tokens
          WHERE token_hash = ?
          LIMIT 1
        `, [usedHash]);
        const current = currentRows[0] ? mapRefreshToken(currentRows[0]!) : used;

        if (current.replacedByHash !== undefined && current.replacedByHash !== "") {
          await this.revokeRefreshFamilyWithDatabase(
            database,
            {
              familyId: current.familyId,
              clientId: current.clientId,
              subject: current.subject,
            },
            (await this.refreshFamilyMaxExpiry(database, used.familyId)) || used.expiresAt,
          );
          return { error: "refresh-token-reused", message: "refresh token already rotated" };
        }

        if (current.revokedAt != null) {
          return { error: "refresh-token-revoked", message: "refresh token revoked" };
        }

        if (current.expiresAt <= now) {
          return { error: "refresh-token-expired", message: "refresh token expired" };
        }

        return { error: "refresh-token-reused", message: "refresh token reused" };
      }

      await database.run(`
        INSERT INTO mcp_oauth_refresh_tokens (
          token_hash, family_id, client_id, subject, scope, resource, issued_at, expires_at, previous_token_hash, revoked_at, replaced_by_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `, [rotatedHash, used.familyId, used.clientId, used.subject, nextScope, used.resource, issuedAt, input.expiresAt, usedHash]);

      await database.run(`
        UPDATE mcp_oauth_refresh_tokens
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE family_id = ? AND token_hash <> ? AND token_hash <> ?
      `, [now, used.familyId, usedHash, rotatedHash]);

      return {
        record: {
          tokenHash: rotatedHash,
          familyId: used.familyId,
          subject: used.subject,
          clientId: used.clientId,
          scope: nextScope,
          resource: used.resource,
          issuedAt,
          expiresAt: input.expiresAt,
          previousTokenHash: usedHash,
        },
      };
    });
    if ("error" in outcome) throw new OAuthRepositoryError(outcome.message, outcome.error);
    return outcome.record;
  }

  private async refreshFamilyMaxExpiry(database: RelationalDatabase, familyId: string): Promise<number> {
    const rows = await database.query<AnyRow>(`
      SELECT MAX(expires_at) AS max_expires_at
      FROM mcp_oauth_refresh_tokens
      WHERE family_id = ?
    `, [familyId]);
    if (rows.length === 0) return 0;
    return Number(rows[0]!.max_expires_at ?? 0);
  }

  async revokeAccessTokenJti(input: OAuthRevocationInput): Promise<void> {
    if (input.type !== "access_jti") {
      throw new Error("access_jti 타입이 아닙니다.");
    }
    await this.database.transaction(async (database) => {
      await this.upsertRevocation(database, {
        type: input.type,
        identifier: input.identifier,
        clientId: input.clientId,
        subject: input.subject,
        familyId: input.familyId,
        reason: input.reason,
        revokedAt: input.revokedAt ?? nowSeconds(),
        expiresAt: input.expiresAt ?? (input.revokedAt ?? nowSeconds()) + 86_400,
      });
    });
  }

  async isAccessTokenRevoked(jti: string, now = nowSeconds()): Promise<boolean> {
    const rows = await this.database.query<AnyRow>(`
      SELECT 1 AS found
      FROM mcp_oauth_revocations
      WHERE revocation_type = 'access_jti' AND identifier = ? AND expires_at > ?
      LIMIT 1
    `, [jti, now]);
    return rows.length > 0;
  }

  private async revokeRefreshFamilyWithDatabase(
    database: RelationalDatabase,
    input: { familyId: string; clientId: string; subject: string },
    expiresAt: number,
    reason = "refresh token reuse detected",
  ): Promise<void> {
    const now = nowSeconds();
    await this.upsertRevocation(database, {
      type: "refresh_family",
      identifier: input.familyId,
      clientId: input.clientId,
      subject: input.subject,
      familyId: input.familyId,
      reason,
      revokedAt: now,
      expiresAt,
    });
    await database.run(`
      UPDATE mcp_oauth_refresh_tokens
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE family_id = ?
    `, [now, input.familyId]);
  }

  async revokeRefreshToken(refreshToken: string, clientId: string): Promise<void> {
    const tokenHash = sha256Base64Url(refreshToken);
    await this.database.transaction(async (database) => {
      const [row] = await database.query<AnyRow>(`
        SELECT token_hash, family_id, client_id, subject, scope, issued_at, expires_at,
               previous_token_hash, replaced_by_hash, revoked_at
        FROM mcp_oauth_refresh_tokens WHERE token_hash = ? LIMIT 1
      `, [tokenHash]);
      if (!row) return;
      const token = mapRefreshToken(row);
      if (token.clientId !== clientId) return;
      await this.revokeRefreshFamilyWithDatabase(
        database,
        { familyId: token.familyId, clientId: token.clientId, subject: token.subject },
        (await this.refreshFamilyMaxExpiry(database, token.familyId)) || token.expiresAt,
        "refresh token revoked by client",
      );
    });
  }

  async upsertConsent(input: OAuthConsentInput): Promise<OAuthConsentRecord> {
    const grantedAt = input.grantedAt ?? nowSeconds();
    const fallback: OAuthConsentRecord = {
      clientId: input.clientId,
      subject: input.subject,
      scope: input.scope,
      grantedAt,
      expiresAt: input.expiresAt,
    };

    return this.database.transaction(async (database) => {
      if (database.dialect === "postgres") {
        await database.run(`
          INSERT INTO mcp_oauth_consents (client_id, subject, scope, granted_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (client_id, subject)
          DO UPDATE SET scope = EXCLUDED.scope, granted_at = EXCLUDED.granted_at, expires_at = EXCLUDED.expires_at
        `, [input.clientId, input.subject, input.scope, grantedAt, input.expiresAt]);
      } else if (database.dialect === "mysql") {
        await database.run(`
          INSERT INTO mcp_oauth_consents (client_id, subject, scope, granted_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE scope = VALUES(scope), granted_at = VALUES(granted_at), expires_at = VALUES(expires_at)
        `, [input.clientId, input.subject, input.scope, grantedAt, input.expiresAt]);
      } else {
        await database.run(`
          INSERT INTO mcp_oauth_consents (client_id, subject, scope, granted_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(client_id, subject) DO UPDATE
          SET scope = excluded.scope, granted_at = excluded.granted_at, expires_at = excluded.expires_at
        `, [input.clientId, input.subject, input.scope, grantedAt, input.expiresAt]);
      }

      const consent = await database.query<AnyRow>(`
        SELECT client_id, subject, scope, granted_at, expires_at
        FROM mcp_oauth_consents
        WHERE client_id = ? AND subject = ?
        LIMIT 1
      `, [input.clientId, input.subject]);
      return consent[0]
        ? mapConsent(consent[0])
        : fallback;
    });
  }

  async getConsent(clientId: string, subject: string): Promise<OAuthConsentRecord | undefined> {
    const rows = await this.database.query<AnyRow>(`
      SELECT client_id, subject, scope, granted_at, expires_at
      FROM mcp_oauth_consents
      WHERE client_id = ? AND subject = ?
      LIMIT 1
    `, [clientId, subject]);
    return rows[0] ? mapConsent(rows[0]!) : undefined;
  }

  async cleanupExpired(now = nowSeconds()): Promise<OAuthCleanupResult> {
    return this.database.transaction(async (database) => {
      const authCode = await database.run(`
        DELETE FROM mcp_oauth_authorization_codes
        WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)
      `, [now, now]);

      const refresh = await database.run(`
        DELETE FROM mcp_oauth_refresh_tokens
        WHERE expires_at <= ?
      `, [now]);

      const revocations = await database.run(`
        DELETE FROM mcp_oauth_revocations
        WHERE expires_at <= ?
      `, [now]);

      const consents = await database.run(`
        DELETE FROM mcp_oauth_consents
        WHERE expires_at <= ?
      `, [now]);

      const familyRows = await database.query<AnyRow>(`
        SELECT DISTINCT family_id
        FROM mcp_oauth_refresh_tokens
        WHERE revoked_at IS NOT NULL
      `);
      for (const family of familyRows) {
        const familyId = String(family.family_id);
        if (!familyId) continue;
        const activeRows = await database.query<AnyRow>(`
          SELECT 1
          FROM mcp_oauth_refresh_tokens
          WHERE family_id = ? AND expires_at > ?
          LIMIT 1
        `, [familyId, now]);
        if (activeRows.length === 0) {
          await database.run(`
            DELETE FROM mcp_oauth_revocations
            WHERE revocation_type = 'refresh_family' AND identifier = ?
          `, [familyId]);
        }
      }

      return {
        authorizationCodesDeleted: authCode.affectedRows,
        refreshTokensDeleted: refresh.affectedRows,
        revocationsDeleted: revocations.affectedRows,
        consentsDeleted: consents.affectedRows,
      };
    });
  }

  private async upsertRevocation(database: RelationalDatabase, input: OAuthRevocationInput): Promise<void> {
    const revokedAt = input.revokedAt ?? nowSeconds();
    const expiresAt = input.expiresAt ?? revokedAt + 900;

    if (database.dialect === "postgres") {
      await database.run(`
        INSERT INTO mcp_oauth_revocations (
          revocation_type, identifier, client_id, subject, family_id, reason, revoked_at, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (revocation_type, identifier)
        DO UPDATE SET
          client_id = EXCLUDED.client_id,
          subject = EXCLUDED.subject,
          family_id = EXCLUDED.family_id,
          reason = EXCLUDED.reason,
          revoked_at = EXCLUDED.revoked_at,
          expires_at = GREATEST(mcp_oauth_revocations.expires_at, EXCLUDED.expires_at)
      `, [
        input.type,
        input.identifier,
        input.clientId,
        input.subject,
        input.familyId,
        input.reason,
        revokedAt,
        expiresAt,
      ]);
      return;
    }

    if (database.dialect === "mysql") {
      await database.run(`
        INSERT INTO mcp_oauth_revocations (
          revocation_type, identifier, client_id, subject, family_id, reason, revoked_at, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          client_id = VALUES(client_id),
          subject = VALUES(subject),
          family_id = VALUES(family_id),
          reason = VALUES(reason),
          revoked_at = VALUES(revoked_at),
          expires_at = GREATEST(expires_at, VALUES(expires_at))
      `, [
        input.type,
        input.identifier,
        input.clientId,
        input.subject,
        input.familyId,
        input.reason,
        revokedAt,
        expiresAt,
      ]);
      return;
    }

    await database.run(`
      INSERT INTO mcp_oauth_revocations (
        revocation_type, identifier, client_id, subject, family_id, reason, revoked_at, expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(revocation_type, identifier) DO UPDATE SET
        client_id = excluded.client_id,
        subject = excluded.subject,
        family_id = excluded.family_id,
        reason = excluded.reason,
        revoked_at = excluded.revoked_at,
        expires_at = MAX(expires_at, excluded.expires_at)
    `, [
      input.type,
      input.identifier,
      input.clientId,
      input.subject,
      input.familyId,
      input.reason,
      revokedAt,
      expiresAt,
    ]);
  }
}
