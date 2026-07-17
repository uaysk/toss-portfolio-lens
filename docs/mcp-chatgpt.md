# Toss Portfolio Lens MCP와 ChatGPT 연결

Toss Portfolio Lens MCP는 국내·미국 주식과 ETF의 조회, 분석, 역사적 백테스트·최적화를 제공합니다. 주문 생성·정정·취소나 임의 URL 프록시는 제공하지 않습니다. 모든 결과는 역사적 데이터에 기반하며 미래 성과를 보장하지 않습니다.

## ChatGPT 앱 메타데이터

| 항목 | 값 |
| --- | --- |
| App name | `Toss Portfolio Lens` |
| Description | `포트폴리오 가격·상관관계·백테스트·최적화 앱` |
| MCP endpoint | `MCP_RESOURCE_URL`의 canonical HTTPS `/mcp` URL |
| OAuth Client ID | `MCP_OAUTH_CLIENT_ID` |
| OAuth Client Secret | bootstrap이 만든 `secrets/mcp-oauth-client-secret` 파일의 값 |
| Redirect URI | ChatGPT 앱 관리 화면에 표시된 값을 `MCP_OAUTH_REDIRECT_URI`에 정확히 입력 |

Client secret은 터미널에 출력하지 말고 권한이 제한된 secret 파일을 보안 편집기 또는 비밀번호 관리자로 열어 ChatGPT 앱 관리 화면에 입력합니다.

## 활성화

MCP는 기본적으로 비활성입니다. 비활성 상태에서는 기존 웹 앱과 HTTP API만 동작하고 `/mcp` 및 OAuth endpoint는 등록되지 않습니다.

1. 기존 앱 환경을 준비합니다.
2. ChatGPT 전용 환경 파일을 만들고 외부 HTTPS 주소와 ChatGPT callback을 입력합니다.
3. OAuth secret을 생성합니다.
4. 기본 Compose와 ChatGPT overlay를 함께 실행합니다.

```bash
cp .env.chatgpt.example .env.chatgpt
npm run mcp:oauth:bootstrap
docker compose -f compose.yaml -f compose.chatgpt.yaml --env-file .env --env-file .env.chatgpt up -d --build web
```

bootstrap은 다음 파일을 만들며 기존 파일을 덮어쓰지 않습니다.

- `secrets/mcp-oauth-client-secret`: 사전 등록 OAuth client secret, mode `0600`
- `secrets/mcp-oauth-signing-key`: RS256 PKCS#8 private key, mode `0600`

`secrets/` 디렉터리는 mode `0700`이며 Git과 Docker build context 전체에서 제외됩니다. Compose는 두 파일을 Docker Secret으로 `/run/secrets`에 read-only 마운트합니다.

운영에서는 `MCP_RESOURCE_URL`과 `MCP_OAUTH_ISSUER`가 HTTPS여야 합니다. `MCP_AUTH_MODE=none`은 production에서 거부되며, 개발 환경에서도 loopback 바인딩에서만 허용됩니다. OAuth 설정이 불완전하면 인증 없이 열리지 않고 앱 시작이 실패합니다.

## OAuth endpoint와 흐름

| Endpoint | 역할 |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 protected resource metadata |
| `GET /.well-known/oauth-authorization-server` | Authorization Server metadata |
| `GET /oauth/jwks.json` | RS256 공개 JWKS |
| `GET /oauth/authorize` | 로그인·승인 화면 |
| `POST /oauth/authorize` | 소유자 로그인, scope 허용·거부 |
| `POST /oauth/token` | authorization code 교환과 refresh rotation |
| `POST /oauth/revoke` | access 또는 refresh token 폐기 |
| `POST/GET/DELETE /mcp` | Streamable HTTP MCP |

흐름은 Authorization Code + PKCE S256입니다. Authorization과 token 요청 모두 정확한 `resource=MCP_RESOURCE_URL`을 요구하며 access token의 `aud`에도 같은 값을 기록합니다. OAuth client는 `client_secret_post`로 인증하고, 실제 소유자는 기존 `DASHBOARD_PASSWORD`를 승인 화면에 입력합니다. 이 비밀번호는 MCP bearer token으로 재사용되지 않습니다.

Authorization code는 일회성 hash로, refresh token은 회전형 opaque token의 hash로 DB에 저장합니다. 이전 refresh token 재사용이 감지되면 family 전체를 폐기합니다. Access token은 RS256 JWT이며 `iss`, `aud`, `sub`, `client_id`, `scope`, `iat`, `nbf`, `exp`, `jti`를 매 요청 검증합니다.

## Scope

| Scope | 도구 |
| --- | --- |
| `market:read` | `search_instruments`, `get_data_availability`, `get_price_series`, `analyze_instrument`, `analyze_asset_relationship`, `get_correlation_matrix`, `find_diversifying_assets`, `analyze_market_regimes`, `find_redundant_assets`, `explain_data_quality` |
| `portfolio:read` | `get_current_portfolio` |
| `backtest:run` | 설정 검증, 백테스트·비교·artifact, 기여도, 최적화·Walk-forward·stress·Pareto·리밸런싱·민감도·Monte Carlo, run 상태·취소·결과 |
| `report:generate` | `generate_backtest_report`, `get_report` |

`run_portfolio_backtest`는 기본적으로 `backtest:run`만 요구합니다. 입력에서 `report.enabled=true`이면 계산 전에 `report:generate`도 확인하고, 부족하면 `WWW-Authenticate`와 MCP `_meta["mcp/www_authenticate"]` challenge를 반환합니다.

## 도구 31개

### 종목·시장 데이터

1. `search_instruments`
2. `get_data_availability`
3. `get_price_series`

### 개별·관계 분석

4. `analyze_instrument`
5. `analyze_asset_relationship`
6. `get_correlation_matrix`

### 백테스트

7. `validate_backtest_config`
8. `run_portfolio_backtest`
9. `compare_backtests`
10. `get_backtest_artifact`

### 실제 포트폴리오와 후보 분석

11. `get_current_portfolio`
12. `find_diversifying_assets`
13. `analyze_market_regimes`
14. `analyze_return_contribution`

### 최적화·stress

15. `optimize_portfolio`
16. `walk_forward_optimize`
17. `stress_test_portfolio`
18. `build_pareto_frontier`
19. `find_redundant_assets`
20. `analyze_rebalance_plan`

### 민감도·품질

21. `analyze_weight_sensitivity`
22. `analyze_start_date_sensitivity`
23. `analyze_rebalance_sensitivity`
24. `analyze_cash_flow_sensitivity`
25. `simulate_portfolio_monte_carlo`
26. `explain_data_quality`

### 장기 작업·보고서

27. `get_run_status`
28. `cancel_run`
29. `get_run_result`
30. `generate_backtest_report`
31. `get_report`

각 도구는 한국어 title/description, Zod input/output schema, 도구별 OAuth security scheme, `readOnlyHint`·`openWorldHint`·`destructiveHint`를 노출합니다.

## 백테스트 보고서 옵션

기본값은 보고서 생성 비활성입니다.

```json
{
  "assets": [
    { "symbol": "069500", "weight": 60 },
    { "symbol": "SPY", "weight": 40 }
  ],
  "startDate": "2020-01-01",
  "endDate": "2025-12-31",
  "initialAmount": 10000000,
  "monthlyCashFlow": 0,
  "rebalanceFrequency": "quarterly",
  "benchmark": "SP500",
  "currencyMode": "KRW",
  "report": {
    "enabled": false,
    "failure_mode": "warn"
  }
}
```

`enabled=false`이면 AI writer 호출과 report storage 쓰기가 없습니다. `enabled=true`이면 백테스트 완료 후 기존 보고서 service와 React `/reports/{reportId}` 페이지를 재사용합니다. request hash, data revision, engine version, report schema/config가 같으면 기존 보고서를 재사용합니다.

- `failure_mode=warn`: 백테스트와 artifact를 유지하고 보고서 실패를 warning으로 반환
- `failure_mode=fail`: tool을 오류로 반환하지만 계산된 run과 artifact는 보존; `generate_backtest_report`로 재시도 가능

## 장기 실행과 resource

백테스트·최적화·Walk-forward·stress·민감도·Monte Carlo의 CPU 집약 계산은 Rust worker가 담당합니다. 기본 `rust_socket` 모드는 persistent Unix domain socket pool로 저지연 실행하고 run 상태를 DB에 저장합니다. PostgreSQL 전용 `external` 모드는 immutable gzip artifact, `SKIP LOCKED` claim, lease·heartbeat·deadline·취소 fencing으로 서버 재시작과 다중 worker를 견딥니다. 동일 request hash와 data revision은 멱등적으로 재사용하며 이미 저장한 결과는 취소 시에도 삭제하지 않습니다.

약 1,000행 또는 200KB를 넘는 시계열은 `structuredContent`에 직접 넣지 않고 다음 resource URI로 분리합니다.

- `market://series/{requestHash}`
- `backtest://runs/{runId}/{artifact}`
- `optimization://runs/{runId}/candidates`
- `optimization://runs/{runId}/walk-forward`

Descriptor에는 format, row/byte count, checksum, 생성 시각, schema version, data revision이 포함됩니다.

## 데이터 규칙과 한계

- 투자 성과·상관·최적화는 공급자가 제공하는 수정주가를 사용합니다.
- 기업행위 반영 범위는 공급자 정의를 따르며 별도 현금배당, 세금, 슬리피지는 포함하지 않습니다.
- KRW 모드는 전체 기간 USD/KRW 경로를 반영하고 현지가격·환율 기여를 분리합니다.
- 거래비용은 추정치만 표시하지 않고 매 체결 시 현금과 성과 경로에서 차감합니다.
- 현금 목표, 정수/소수 수량, 잔여 현금, 현금 수익률, 임계치·정기·현금흐름 리밸런싱을 지원합니다.
- 사용자 지정 입출금은 다음 공통 실제 관측일에 적용하고 unitized TWR와 XIRR을 함께 반환합니다.
- 상관과 관계 분석은 휴장일을 0%로 만들지 않고 실제 공통 관측일의 수익률을 inner join합니다.
- 평가금 경로에서 가격 또는 환율 carry-forward가 발생하면 횟수와 경고를 반환합니다.
- 실제 계좌 도구는 opaque selector와 원화 환산 비중만 반환하며 계좌 번호와 금액을 노출하지 않습니다.
- 현재 cache universe를 사용하는 후보 탐색은 전체 시장 검색으로 표현하지 않습니다.
- 최적화 결과는 표본 내 역사적 결과이며 미래 성과 보장이 아닙니다.

## MCP 호출 감사 로그

MCP `tools/call`은 별도 DB 테이블 `mcp_tool_audit_log`에 기록합니다. 정상 호출뿐 아니라 unknown tool, 잘못된 입력, scope 부족과 handler/output 오류도 포함하며 SDK의 실제 JSON-RPC request ID를 내부 UUID와 함께 보존합니다. OAuth subject와 session ID는 HMAC hash로만 저장합니다. 도구 인자, 응답 본문, access/refresh token, 계좌 식별자와 평가금은 저장하지 않습니다. 저장은 일시 오류에 재시도하고 도구 실행 결과와 분리되며, `MCP_AUDIT_RETENTION_DAYS`(기본 90일) 이전 행은 시작 시와 주기적으로 정리합니다.

## 검증

OAuth 승인 화면과 합성 보고서 페이지를 데스크톱·모바일 viewport에서 렌더링하고 콘솔 오류, 요청 실패, 전체 페이지 가로 overflow를 확인하려면 production build 후 다음을 실행합니다. 이 검증은 임시 SQLite와 합성 데이터만 사용하고 스크린샷이나 secret을 남기지 않습니다.

```bash
npm run build
npm run mcp:browser:smoke
```

OAuth HTTP smoke는 실제 서버에 대해 metadata, 로그인·승인, PKCE, token, MCP initialize/tools/list/tool call, scope challenge, refresh rotation/reuse detection, revocation과 binding 오류를 확인합니다. 비밀값은 출력하지 않습니다.

```bash
docker compose -f compose.yaml -f compose.chatgpt.yaml exec \
  -e MCP_SMOKE_BASE_URL=http://127.0.0.1:3200 \
  web npm run mcp:oauth:smoke
```

MCP Inspector는 다음처럼 시작한 뒤 UI에서 HTTPS MCP endpoint와 사전 등록 OAuth client 정보를 입력합니다.

```bash
npx @modelcontextprotocol/inspector
```

Inspector에서 `initialize`, `tools/list`, `get_data_availability`, 작은 `get_price_series`, `validate_backtest_config` 순으로 확인합니다. 실제 계좌가 필요한 도구 대신 합성·공개 종목 입력을 사용합니다.

## 운영 환경변수

| 변수 | 기본값/역할 |
| --- | --- |
| `MCP_ENABLED` | `false`; MCP와 OAuth 전체 활성화 |
| `MCP_AUTH_MODE` | `oauth`; 로컬 loopback에서만 `none` 허용 |
| `MCP_RESOURCE_URL` | canonical HTTPS `/mcp` URL |
| `MCP_OAUTH_ISSUER` | path 없는 HTTPS Authorization Server origin |
| `MCP_OAUTH_CLIENT_ID` | 사전 등록 client ID |
| `MCP_OAUTH_CLIENT_NAME` | 승인 화면 앱 이름 |
| `MCP_OAUTH_CLIENT_SECRET_FILE` | client secret 파일 |
| `MCP_OAUTH_SIGNING_KEY_FILE` | RSA private key 파일 |
| `MCP_OAUTH_REDIRECT_URI` | ChatGPT callback과 정확히 일치 |
| `MCP_OAUTH_AUTO_APPROVE` | `false`; test 외 환경에서 `true` 거부 |
| `MCP_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `MCP_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `MCP_AUTH_CODE_TTL_SECONDS` | `300` |
| `MCP_OAUTH_SESSION_TTL_SECONDS` | `900` |
| `MCP_MAX_REQUESTS_PER_MINUTE` | OAuth/MCP 독립 rate limit |
| `MCP_MAX_CONCURRENT_RUNS` | 전체 동시 실행 상한 |
| `MCP_MAX_RUNS_PER_SUBJECT` | owner별 활성 run 상한 |
| `MCP_MAX_ASSETS` | 분석 종목 수 상한 |
| `MCP_MAX_CANDIDATE_BUDGET` | 최적화 후보 수 상한 |
| `MCP_MAX_DATE_RANGE_YEARS` | 날짜 범위 상한 |
| `MCP_INLINE_RESULT_MAX_ROWS` | inline 행 상한 |
| `MCP_INLINE_RESULT_MAX_BYTES` | inline byte 상한 |
| `MCP_AUDIT_RETENTION_DAYS` | MCP 도구 감사 로그 보존 기간; 기본 `90`일 |
| `MCP_ALLOWED_ORIGINS` | 브라우저 MCP client가 있을 때만 정확한 origin 지정 |

## 롤백

1. `.env.chatgpt`에서 `MCP_ENABLED=false`로 바꾸거나 ChatGPT overlay 없이 기존 Compose만 재배포합니다.
2. `/api/health`가 `mcp: "disabled"`, `mcpAuth: "disabled"`를 반환하는지 확인합니다.
3. OAuth client를 ChatGPT 앱 관리 화면에서 비활성화합니다.
4. OAuth secret 파일과 MCP DB 테이블은 즉시 삭제하지 않고 보존해 기존 웹 앱과 감사 기록에 영향을 주지 않도록 합니다.

MCP 테이블은 기존 포트폴리오·candle·보고서 테이블과 분리되어 있으므로 `MCP_ENABLED=false` 롤백에는 DB schema 삭제가 필요하지 않습니다.
