# Implementation Plan

## 실행 원칙

- 이 작업 목록은 **애플리케이션 저장소**에서 실행한다.
- 한 top-level 작업을 완료할 때 관련 테스트와 타입 검사를 먼저 통과시킨다.
- 실제 토스·OpenAI·AWS secret이 없어도 mock server와 fixture로 전체 흐름을 검증할 수 있어야 한다.
- 실제 주문 mutation은 어떤 단계에서도 구현하지 않는다.
- 사용자가 별도 요청하지 않는 한 배포, ECR push, AWS 변경은 수행하지 않는다.

## Tasks

- [ ] 1. 프로젝트 기반과 품질 도구 구성
  - [ ] 1.1 Node 22, TypeScript strict ESM, React 19, Vite, Express 5, Tailwind, Vitest 프로젝트를 만든다.
  - [ ] 1.2 shadcn/ui 방식의 Button, Card, Input, Label, Select, Skeleton primitive를 구성한다.
  - [ ] 1.3 `dev`, `typecheck`, `test`, `build`, `start` script와 path alias를 구성한다.
  - [ ] 1.4 공통 API error, account, holding, portfolio, history, analysis, backtest, report type을 정의한다.
  - [ ] 1.5 기본 error boundary와 404 SPA fallback을 구성한다.
  - _Requirements: 1.6, 8.8, 16.8_

- [ ] 2. 환경 구성 검증과 서버 bootstrap 구현
  - [ ] 2.1 필수·선택 환경 변수를 순수 parser로 구현하고 길이·URL·범위 검증 테스트를 작성한다.
  - [ ] 2.2 `HOST=0.0.0.0`, `PORT=3200`, KST 기준 날짜 helper를 구현한다.
  - [ ] 2.3 graceful shutdown에서 HTTP server, timer, DB를 닫는 lifecycle을 구현한다.
  - [ ] 2.4 `.env.example`에는 자리표시자만 넣고 `.env`와 runtime data를 Git에서 제외한다.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 15.5_

- [ ] 3. 비밀번호 인증과 세션 보호 구현
  - [ ] 3.1 HMAC 서명 12시간 stateless session token과 일정 시간 비교를 구현한다.
  - [ ] 3.2 login/session/logout route와 HttpOnly, SameSite=Strict, conditional Secure cookie를 구현한다.
  - [ ] 3.3 trusted proxy 설정과 IP별 15분/5회 in-memory rate limiter를 구현한다.
  - [ ] 3.4 보호 route middleware와 공통 401 처리를 구현한다.
  - [ ] 3.5 cookie 변조·만료·로그인 제한·성공 초기화 테스트를 작성한다.
  - _Requirements: 2.1–2.7, 15.3, 16.1_

- [ ] 4. 토스증권 조회 전용 gateway 구현
  - [ ] 4.1 OAuth token을 메모리에만 cache하고 동시 refresh를 single-flight로 만든다.
  - [ ] 4.2 timeout, AbortSignal, 오류 매핑을 포함한 공통 GET client를 구현한다.
  - [ ] 4.3 계좌와 국내·해외 holdings 응답을 내부 model로 정규화한다.
  - [ ] 4.4 OPEN/CLOSED 주문 목록·상세 cursor 조회와 종목/일봉/환율/지수 GET client를 구현한다.
  - [ ] 4.5 source에서 POST 주문, 정정, 취소와 거래 가능 수량 호출이 존재하지 않는지 allowlist 테스트로 고정한다.
  - [ ] 4.6 mock upstream으로 token reuse/refresh, pagination, 429, timeout, malformed payload 테스트를 작성한다.
  - _Requirements: 3.1–3.7, 16.1_

- [ ] 5. 제한된 토스 호환 API 구현
  - [ ] 5.1 `DASHBOARD_PASSWORD` Bearer 검증 middleware를 일정 시간 비교로 구현한다.
  - [ ] 5.2 accounts, holdings, orders 목록·상세 route와 계좌 header 검증을 구현한다.
  - [ ] 5.3 requirements의 시장·종목·지수 GET allowlist와 feature별 query allowlist를 구현한다.
  - [ ] 5.4 미등록 path, non-GET, forbidden query를 상위 호출 전에 거부한다.
  - [ ] 5.5 모든 응답에 no-store를 적용하고 route matrix 테스트를 작성한다.
  - _Requirements: 4.1–4.7, 16.1_

- [ ] 6. SQLite/MySQL 공통 저장소 contract 구현
  - [ ] 6.1 query/run/transaction/close를 가진 dialect-neutral DB interface를 만든다.
  - [ ] 6.2 SQLite adapter와 schema 초기화를 구현한다.
  - [ ] 6.3 `mysql2` pool adapter, 선택적 TLS/CA, schema 초기화를 구현한다.
  - [ ] 6.4 snapshot, items, orders, instruments, daily/backtest/benchmark prices, FX, backfill state, meta repository를 구현한다.
  - [ ] 6.5 natural key upsert, cascade, index와 date query를 temporary DB 테스트로 검증한다.
  - _Requirements: 9.1, 9.2, 9.8, 9.9, 16.2_

- [ ] 7. SQLite → MySQL 자동 마이그레이션과 선택 정책 구현
  - [ ] 7.1 MySQL config completeness와 `MYSQL_REQUIRED` 선택 flow를 구현한다.
  - [ ] 7.2 SQLite fingerprint 계산과 storage meta 기록을 구현한다.
  - [ ] 7.3 parent-first transactional idempotent upsert와 최신 destination 행 보호를 구현한다.
  - [ ] 7.4 local fallback 후 SQLite 변경분이 다음 MySQL 연결 때 재이동되는 흐름을 구현한다.
  - [ ] 7.5 empty/partial/existing-newer/repeat/failure rollback integration test를 작성한다.
  - _Requirements: 9.1–9.9, 16.2_

- [ ] 8. 현재 포트폴리오 API와 5초 polling 구현
  - [ ] 8.1 선택 계좌 검증, holdings 정규화, 통화별 summary 계산을 구현한다.
  - [ ] 8.2 `/api/portfolio` 응답 후 오늘 live snapshot을 안전하게 upsert한다.
  - [ ] 8.3 dashboard loader에서 visibility-aware 5초 polling, 수동 refresh, account 변경 취소를 구현한다.
  - [ ] 8.4 loading, empty, upstream error, unauthorized 상태를 구현한다.
  - [ ] 8.5 fake timer와 out-of-order response 회귀 테스트를 작성한다.
  - _Requirements: 5.1–5.7, 6.6, 16.6_

- [ ] 9. 과거 주문·가격·환율 backfill 구현
  - [ ] 9.1 계좌별 single-flight 상태 기계와 persisted counters를 구현한다.
  - [ ] 9.2 CLOSED 주문 전체 cursor 수집과 첫 체결일 탐지를 구현한다.
  - [ ] 9.3 과거/current instrument metadata와 비수정 OHLC, USD/KRW 환율 pagination/cache를 구현한다.
  - [ ] 9.4 BUY/SELL 누적 수량, 과거 값 carry-forward, 원화 환산 일별 reconstruction을 구현한다.
  - [ ] 9.5 현재 잔고 reconciliation과 partial/failed symbol 진단을 구현한다.
  - [ ] 9.6 startup, 6시간 timer, dashboard trigger, manual retry를 연결한다.
  - [ ] 9.7 주말·휴일·동일일 다중 fill·전량매도·해외 과거 종목·수량 불일치 fixture 테스트를 작성한다.
  - _Requirements: 6.1–6.10, 17.1–17.4, 16.3_

- [ ] 10. 과거 history API와 날짜 범위 처리 구현
  - [ ] 10.1 `currency=ALL`, preset range, custom from/to validation을 구현한다.
  - [ ] 10.2 국내·해외 snapshot을 날짜별 FX로 합산한 KRW history series를 만든다.
  - [ ] 10.3 기간 평균 비중, first snapshot, capturedAt, total value를 안정적으로 계산한다.
  - [ ] 10.4 history/status/backfill route의 session·error contract를 테스트한다.
  - _Requirements: 6.8, 7.1–7.3, 15.3_

- [ ] 11. 다크 우선 dashboard shell과 Overview UI 구현
  - [ ] 11.1 첫 paint dark theme, light toggle, localStorage persistence를 구현한다.
  - [ ] 11.2 login 화면, desktop sidebar, mobile 3-tab nav, account/theme/refresh/logout header를 구현한다.
  - [ ] 11.3 장식 원형 없는 단색 portfolio hero와 summary cards를 구현한다.
  - [ ] 11.4 국내·해외 통합 holdings list와 검색·responsive card/table 전환을 구현한다.
  - [ ] 11.5 Top 10 + 기타 asset allocation을 구현하고 통화 원본을 명확히 표시한다.
  - [ ] 11.6 border/gradient 사용을 제거하고 320px responsive·keyboard focus를 검증한다.
  - _Requirements: 5.2, 5.3, 5.8, 5.9, 8.1–8.4, 8.8, 8.9_

- [ ] 12. 종목별 누적 Area 차트와 표시 설정 구현
  - [ ] 12.1 raw KRW evaluation amount를 stack해 날짜별 전체 높이가 평가액을 따르는 chart data builder를 구현한다.
  - [ ] 12.2 7/30/90/all preset과 유효성 검증이 있는 KST date picker를 구현한다.
  - [ ] 12.3 key hash 기반 dark/light 유채색 palette와 stroke 없는 solid Area를 구현한다.
  - [ ] 12.4 hover point의 0값 series를 제외하고 inside label/leader-line collision layout을 구현한다.
  - [ ] 12.5 tooltip content를 제거하고 범례·평균 비중·loading/partial/empty state를 구현한다.
  - [ ] 12.6 현재 holdings와 history series를 합친 숨김 설정 및 localStorage persistence를 구현한다.
  - [ ] 12.7 숨김이 원본 summary를 바꾸지 않게 하고 chart/filter/label unit test를 작성한다.
  - _Requirements: 7.1–7.10, 8.5–8.7, 16.6_

- [ ] 13. 포트폴리오 분석 엔진과 API 구현
  - [ ] 13.1 holdings quantity × 종목 OHLC × daily FX의 통합 KRW 추정 candle을 구현한다.
  - [ ] 13.2 KOSPI/KOSDAQ/QQQ/SPY benchmark cache와 partial error를 구현한다.
  - [ ] 13.3 공통 기준일 trim·forward-fill 규칙과 모든 계열 0% 시작 정규화를 구현한다.
  - [ ] 13.4 trade-adjusted daily return, TWR, XIRR, CAGR, volatility, drawdown, Sharpe, Sortino, Calmar를 구현한다.
  - [ ] 13.5 집중도, 비용, turnover, benchmark/excess, best/worst day, positive day 지표를 구현한다.
  - [ ] 13.6 signed contribution 계산과 원래 값 내림차순 정렬을 구현한다.
  - [ ] 13.7 null/zero/sample 부족과 매도·현금 부재 limitations를 포함한 API 테스트를 작성한다.
  - [ ] 13.8 미국 proxy KRW 환산과 tracking error·information ratio·beta·alpha·capture·relative MDD를 구현한다.
  - [ ] 13.9 rolling return/risk, drawdown recovery, VaR/CVaR, monthly heatmap 계산을 구현한다.
  - [ ] 13.10 time-linked local/FX attribution, risk contribution, correlation, exposure와 diversification benefit을 구현한다.
  - [ ] 13.11 비용효율·월별 turnover·FIFO 거래 추정치와 data confidence를 구현한다.
  - _Requirements: 10.1–10.10, 11.1–11.10, 16.4, 17.1–17.3_

- [ ] 14. 분석 탭 UI 구현
  - [ ] 14.1 30/90/1y/all과 custom date, multi benchmark selector를 구현한다.
  - [ ] 14.2 normalized candlestick와 benchmark line을 동일 domain·기준일로 그린다.
  - [ ] 14.3 returns, risk, risk-adjusted, concentration, trading/cost metric section을 구성한다.
  - [ ] 14.4 국내·해외 통합 기여도 목록을 signed 값 순으로 표시한다.
  - [ ] 14.5 OHLC 추정, ETF proxy, 입출금/예수금 부재, TWR/XIRR 한계를 인접한 위치에 표시한다.
  - [ ] 14.6 mobile overflow, chart tooltip, benchmark failure UI를 검증한다.
  - [ ] 14.7 active risk, rolling, drawdown, tail risk, monthly return, risk contribution, correlation, cost와 confidence section을 구현한다.
  - [ ] 14.8 사용자 risk-free rate 입력을 분석 API와 AI report 재계산에 연결한다.
  - _Requirements: 10.1–10.10, 11.1–11.10, 8.8, 8.9_

- [ ] 15. 백테스트 가격 서비스와 simulation engine 구현
  - [ ] 15.1 국내 6자리·미국 ticker canonicalization, metadata/list date resolver와 수정주가 cache를 구현한다.
  - [ ] 15.2 현재 holdings 원화 환산 비중과 latest-list-date 기본 기간 API를 구현한다.
  - [ ] 15.3 1..20 asset, weight sum, date, amount, duplicate validation을 구현한다.
  - [ ] 15.4 공통 실제 시작일, local-return virtual units, 월 cash flow, 4개 rebalance mode를 구현한다.
  - [ ] 15.5 고정 지수/ETF와 국내·해외 개별 종목 benchmark의 growth, drawdown, annual return, contribution, correlation과 전체 비교 metric을 구현한다.
  - [ ] 15.6 deterministic fixture로 no-rebalance/rebalance/deposit/withdrawal/missing-price test를 작성한다.
  - [ ] 15.7 configurable risk-free rate, active risk/capture, rolling, drawdown episode, tail-risk와 monthly return analytics를 구현한다.
  - [ ] 15.8 평균/종료 비중 기반 risk contribution·집중도와 virtual trade ledger 기반 turnover/cost·FIFO statistics를 구현한다.
  - [ ] 15.9 candle 관측·carry-forward·공통 기간 기반 data confidence와 deterministic 회귀 테스트를 구현한다.
  - _Requirements: 12.1–12.23, 16.5_

- [ ] 16. 백테스트 탭 UI 구현
  - [ ] 16.1 현재 포트폴리오 불러오기와 종목 검색·추가·삭제·비중 편집을 구현한다.
  - [ ] 16.2 기본/실제 시작일, 종료일, 초기금, 월 현금흐름, rebalance, 고정/개별 종목 benchmark controls를 구현한다.
  - [ ] 16.3 growth/contribution, drawdown, annual returns, signed contributions, 각 지표 아래 benchmark 비교값, 종목명을 양축 머리글로 쓰는 무채색 correlation matrix를 구현한다.
  - [ ] 16.4 loading/progress/validation/error/limitations와 mobile layout을 구현한다.
  - [ ] 16.5 종목 삭제 시 남은 종목 비중을 보존하고 unit test로 회귀를 막는다.
  - [ ] 16.6 risk-free/cost controls와 active risk, rolling, tail-risk, monthly heatmap, risk contribution, concentration, turnover/FIFO, data confidence sections를 구현한다.
  - _Requirements: 12.1–12.23, 8.8, 8.9_

- [ ] 17. OpenAI narrative writer와 report service 구현
  - [ ] 17.1 OpenAI config pair validation, optional model discovery, Responses endpoint normalization과 명시적 미지원 시 Chat Completions fallback을 구현한다.
  - [ ] 17.2 strict narrative JSON schema, Korean safety instructions, `store=false`, timeout/error mapping을 구현한다.
  - [ ] 17.3 analysis와 backtest를 서버에서 재계산하고 account ID를 제거한 bounded prompt builder를 구현한다.
  - [ ] 17.4 report ID, versioned schema, local atomic JSON storage를 구현한다.
  - [ ] 17.5 private S3 storage를 default credential chain으로 구현하고 local/S3를 startup에 선택한다.
  - [ ] 17.6 생성 route와 public read route, no-store/noindex header, 동일 404를 구현한다.
  - [ ] 17.7 mock AI/local/S3로 success, refusal, 429, timeout, malformed schema, storage failure, PII 제거 테스트를 작성한다.
  - _Requirements: 13.1–13.9, 14.1, 14.3–14.9, 16.7_

- [ ] 18. 고정 report UI 템플릿 구현
  - [ ] 18.1 `/reports/:id`를 인증 shell과 분리해 public report loader로 구현한다.
  - [ ] 18.2 `portfolio-report-v1` header, score/stance, summary, strengths/risks/actions/methodology를 구현한다.
  - [ ] 18.3 analysis/backtest별 metric cards, interactive chart, contribution과 limitations를 고정 layout에 배치한다.
  - [ ] 18.4 dark/light, no border/gradient, responsive, loading/not-found/error를 구현한다.
  - [ ] 18.5 report 생성 버튼과 새 URL 열기/복사를 분석·백테스트 탭에 연결한다.
  - _Requirements: 13.7, 14.1–14.4, 14.8, 14.9_

- [ ] 19. 상태 확인, 보안 header와 운영 관측성 마무리
  - [ ] 19.1 `/api/health`에 DB/report storage/report generation의 비민감 상태를 구현한다.
  - [ ] 19.2 request category와 upstream request ID만 남기는 구조화 logging/redaction을 구현한다.
  - [ ] 19.3 report와 금융 API에 cache/robot header를 적용하고 static asset cache와 분리한다.
  - [ ] 19.4 secret·cookie·authorization·account payload가 로그나 client bundle에 없는지 정적/동적 점검한다.
  - _Requirements: 15.1–15.5, 14.8, 16.1_

- [ ] 20. 컨테이너, Compose와 문서 완성
  - [ ] 20.1 build stage에서 typecheck/test/build 후 production dependency만 남기는 multi-stage Dockerfile을 만든다.
  - [ ] 20.2 비루트 사용자, `/app/data` 쓰기 권한, port 3200, healthcheck를 구성한다.
  - [ ] 20.3 Compose web service, named volume, env file, restart policy를 구성한다.
  - [ ] 20.4 로컬 SQLite, optional MySQL, migration, read-only API, reports, limitations, troubleshooting README를 작성한다.
  - [ ] 20.5 `.dockerignore`가 `.env`, data, report, Git, tests artifact를 build context에서 제외하는지 확인한다.
  - _Requirements: 1.1–1.6, 9.1–9.9, 16.8_

- [ ] 21. 전체 회귀와 실제 렌더링 검증
  - [ ] 21.1 `npm run typecheck`, `npm test`, `npm run build`, Docker build를 실행해 모두 통과시킨다.
  - [ ] 21.2 mock Toss/OpenAI와 temporary DB를 사용한 end-to-end fixture mode를 준비한다. 운영 build에서는 이 mode를 활성화할 수 없어야 한다.
  - [ ] 21.3 Compose를 `0.0.0.0:3200`에 실행하고 health/login/overview/analysis/backtest/report API를 smoke test한다.
  - [ ] 21.4 실제 브라우저로 320×800, 768×1024, 1440×900에서 dark/light와 모든 화면을 렌더링한다.
  - [ ] 21.5 Area 내부 label/callout/0값 제외, chart 공통 기준점, signed contribution 순서, Top 10, 과거 sold 종목 숨김을 시각 확인한다.
  - [ ] 21.6 console error, failed network, overflow, 겹침, keyboard focus를 확인하고 발견된 회귀를 수정한다.
  - _Requirements: 16.1–16.9, 7.4–7.10, 10.6, 11.8_
