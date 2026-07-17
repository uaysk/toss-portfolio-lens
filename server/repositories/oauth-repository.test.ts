import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "../database.js";
import { OAuthRepository, OAuthRepositoryError } from "./oauth-repository.js";

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("OAuthRepository", () => {
  const databases: SqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  async function createRepository() {
    const database = new SqliteDatabase(":memory:");
    databases.push(database);
    const repository = new OAuthRepository(database);
    await repository.ensureSchema();
    return { database, repository };
  }

  it("authorization code를 hash로 저장하고 client, redirect, resource, PKCE 검증 후 한 번만 소비한다", async () => {
    const { database, repository } = await createRepository();
    const verifier = "v".repeat(43);
    const rawCode = "authorization-code-that-must-not-be-stored";
    await repository.createAuthorizationCode({
      clientId: "chatgpt-client",
      subject: "owner",
      redirectUri: "https://chatgpt.example/callback",
      scope: "market:read backtest:run",
      code: rawCode,
      codeChallenge: challenge(verifier),
      codeChallengeMethod: "S256",
      resource: "https://portfolio.example/mcp",
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
    });

    await expect(repository.consumeAuthorizationCode({
      code: rawCode,
      clientId: "chatgpt-client",
      redirectUri: "https://chatgpt.example/callback",
      resource: "https://portfolio.example/wrong",
      codeVerifier: verifier,
    })).rejects.toMatchObject({ code: "auth-code-binding-invalid" });

    const consumed = await repository.consumeAuthorizationCode({
      code: rawCode,
      clientId: "chatgpt-client",
      redirectUri: "https://chatgpt.example/callback",
      resource: "https://portfolio.example/mcp",
      codeVerifier: verifier,
    });
    expect(consumed).toMatchObject({ subject: "owner", resource: "https://portfolio.example/mcp" });
    expect(await repository.consumeAuthorizationCode({
      code: rawCode,
      clientId: "chatgpt-client",
      redirectUri: "https://chatgpt.example/callback",
      resource: "https://portfolio.example/mcp",
      codeVerifier: verifier,
    })).toBeUndefined();

    const rows = await database.query<Record<string, unknown>>("SELECT * FROM mcp_oauth_authorization_codes");
    expect(JSON.stringify(rows)).not.toContain(rawCode);
  });

  it("refresh token을 resource에 결합하고 scope 오류에서는 소비하지 않은 채 회전한다", async () => {
    const { database, repository } = await createRepository();
    const original = "refresh-token-original-secret";
    await repository.createRefreshToken({
      subject: "owner",
      clientId: "chatgpt-client",
      scope: "market:read backtest:run",
      resource: "https://portfolio.example/mcp",
      refreshToken: original,
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    });

    await expect(repository.rotateRefreshToken({
      usedRefreshToken: original,
      rotatedRefreshToken: "must-not-be-created",
      clientId: "chatgpt-client",
      resource: "https://portfolio.example/mcp",
      requestedScope: "report:generate",
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    })).rejects.toMatchObject({ code: "refresh-token-scope-invalid" });

    const rotatedRaw = "refresh-token-rotated-secret";
    const rotated = await repository.rotateRefreshToken({
      usedRefreshToken: original,
      rotatedRefreshToken: rotatedRaw,
      clientId: "chatgpt-client",
      resource: "https://portfolio.example/mcp",
      requestedScope: "market:read",
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    });
    expect(rotated).toMatchObject({ scope: "market:read", resource: "https://portfolio.example/mcp" });
    const rows = await database.query<Record<string, unknown>>("SELECT * FROM mcp_oauth_refresh_tokens");
    expect(JSON.stringify(rows)).not.toContain(original);
    expect(JSON.stringify(rows)).not.toContain(rotatedRaw);
  });

  it("회전된 refresh token 재사용을 탐지해 family 전체를 폐기한다", async () => {
    const { repository } = await createRepository();
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    await repository.createRefreshToken({
      subject: "owner",
      clientId: "chatgpt-client",
      scope: "backtest:run",
      resource: "https://portfolio.example/mcp",
      refreshToken: "family-original",
      expiresAt,
    });
    const rotated = await repository.rotateRefreshToken({
      usedRefreshToken: "family-original",
      rotatedRefreshToken: "family-second",
      clientId: "chatgpt-client",
      resource: "https://portfolio.example/mcp",
      expiresAt,
    });

    await expect(repository.rotateRefreshToken({
      usedRefreshToken: "family-original",
      rotatedRefreshToken: "attacker-token",
      clientId: "chatgpt-client",
      resource: "https://portfolio.example/mcp",
      expiresAt,
    })).rejects.toMatchObject({ code: "refresh-token-reused" });
    expect(await repository.isRefreshFamilyRevoked(rotated.familyId)).toBe(true);
    await expect(repository.rotateRefreshToken({
      usedRefreshToken: "family-second",
      rotatedRefreshToken: "family-third",
      clientId: "chatgpt-client",
      resource: "https://portfolio.example/mcp",
      expiresAt,
    })).rejects.toMatchObject({ code: "refresh-token-family-revoked" });
  });

  it("동일 refresh token 동시 회전에서 하나만 성공시키고 재사용 family를 폐기한다", async () => {
    const { repository } = await createRepository();
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const created = await repository.createRefreshToken({
      subject: "owner",
      clientId: "chatgpt-client",
      scope: "backtest:run",
      resource: "https://portfolio.example/mcp",
      refreshToken: "concurrent-original",
      expiresAt,
    });
    const results = await Promise.allSettled(["next-a", "next-b"].map((rotatedRefreshToken) => (
      repository.rotateRefreshToken({
        usedRefreshToken: "concurrent-original",
        rotatedRefreshToken,
        clientId: "chatgpt-client",
        resource: "https://portfolio.example/mcp",
        expiresAt,
      })
    )));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(OAuthRepositoryError);
    expect(rejected?.reason).toMatchObject({ code: "refresh-token-reused" });
    expect(await repository.isRefreshFamilyRevoked(created.familyId)).toBe(true);
  });
});
