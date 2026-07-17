export type McpScopeId = "market:read" | "portfolio:read" | "backtest:run" | "report:generate";

export type McpScopeDefinition = {
  id: McpScopeId;
  name: string;
  descriptionKo: string;
};

export const MCP_SCOPES: ReadonlyArray<McpScopeDefinition> = [
  { id: "market:read", name: "시장 데이터 조회", descriptionKo: "시장 지표와 가격 데이터 조회 권한" },
  { id: "portfolio:read", name: "포트폴리오 조회", descriptionKo: "보유 포트폴리오와 거래내역 조회 권한" },
  { id: "backtest:run", name: "백테스트 실행", descriptionKo: "백테스트 수행 및 결과 생성 권한" },
  { id: "report:generate", name: "리포트 생성", descriptionKo: "리포트 생성 및 출력 권한" },
];

export const MCP_SCOPE_IDS: ReadonlyArray<McpScopeId> = MCP_SCOPES.map((scope) => scope.id);

export const MCP_SCOPE_SET = new Set<McpScopeId>(MCP_SCOPE_IDS);

export type InsufficientScopeChallenge = {
  error: "insufficient_scope";
  error_description: string;
  scope: string;
};

function normalizeScopeValue(scope: string): string {
  return scope.trim();
}

function isKnownScope(scope: string): scope is McpScopeId {
  return MCP_SCOPE_SET.has(scope as McpScopeId);
}

export function parseScopeString(scope: string | readonly string[] | undefined): ReadonlySet<McpScopeId> {
  const values = Array.isArray(scope)
    ? scope
    : typeof scope === "string"
      ? scope.split(/\s+/)
      : [];
  if (!values || values.length === 0) return new Set<McpScopeId>();
  const parsed = values
    .map((value) => normalizeScopeValue(value))
    .filter(Boolean)
    .filter(isKnownScope);

  return new Set(parsed);
}

export function validateRequestedScopes(scope: string | readonly string[] | undefined): McpScopeId[] {
  const values = (Array.isArray(scope) ? scope : typeof scope === "string" ? scope.split(/\s+/) : [])
    .map(normalizeScopeValue)
    .filter(Boolean);
  const unknown = values.filter((value) => !isKnownScope(value));
  if (unknown.length) throw new Error(`지원하지 않는 OAuth scope입니다: ${unknown.join(", ")}`);
  return Array.from(new Set(values.filter(isKnownScope)));
}

export function hasScopes(
  grantedScope: string | readonly string[],
  requiredScopes: readonly McpScopeId[],
): boolean {
  const granted = Array.isArray(grantedScope)
    ? new Set(
        grantedScope
          .map((scope) => normalizeScopeValue(scope))
          .filter(isKnownScope),
      )
    : parseScopeString(grantedScope);

  return requiredScopes.every((scope) => granted.has(scope));
}

export function insufficientScopeChallenge(requiredScopes: readonly McpScopeId[]): InsufficientScopeChallenge {
  return {
    error: "insufficient_scope",
    error_description: "요청한 API는 더 넓은 권한 범위를 필요로 합니다.",
    scope: requiredScopes.join(" "),
  };
}
