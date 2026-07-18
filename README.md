# Toss Portfolio Lens

토스증권 Open API 또는 호환 조회 API의 계좌·보유 종목·체결·시세 데이터를 모아 포트폴리오 현황, 성과 분석, 백테스트와 전략 연구를 제공하는 읽기 전용 애플리케이션입니다.

국내 상장 종목과 USD 해외 종목을 하나의 포트폴리오에서 분석할 수 있으며, 과거 USD/KRW 환율과 현금흐름을 반영한 원화 기준 성과 경로를 계산합니다. 주문 생성·정정·취소 기능은 제공하지 않습니다.

![Portfolio Lens 포트폴리오 화면](docs/readme/overview.png)

> 화면은 문서용 예시 데이터로 재현한 제품 UI입니다. 실제 계좌나 실제 운용 성과를 나타내지 않습니다.

## 주요 기능

### 포트폴리오와 성과 분석

- 계좌별 평가금, 손익, 보유 종목과 자산 구성
- 일별 평가금과 과거 비중 변화 복원
- 국내·해외 자산의 KRW 통합 평가와 과거 USD/KRW 환율 반영
- TWR, XIRR, CAGR, 변동성, MDD, Sharpe, Sortino, Calmar
- VaR·CVaR, 낙폭 구간, 상관관계, 위험 기여도와 집중도
- KOSPI, KOSDAQ, Nasdaq 100, S&P 500 또는 사용자 지정 종목과 비교
- 가격·환율 관측률, 공통 수익률 관측일과 carry-forward 현황 표시

### 포트폴리오 백테스트

국내 6자리 종목 코드와 미국 티커를 함께 입력할 수 있습니다. 데이터가 캐시되어 있지 않으면 Node control plane이 필요한 수정주가와 환율을 공급자에서 조회해 캐시한 뒤 Rust worker에 계산을 요청합니다.

![Portfolio Lens 백테스트 화면](docs/readme/backtest.png)

- 초기 투자금과 목표 현금 비중
- 소수 수량 또는 정수 수량·lot size와 잔여 현금
- 월·분기·연 단위 또는 목표 비중 이탈 임계치 리밸런싱
- 정기 현금흐름과 날짜별 사용자 지정 입출금
- 목표 비중, drift 감소 또는 전체 리밸런싱 방식
- 체결금액 기준 거래비용의 실제 포트폴리오 경로 차감
- 현금 수익률, TWR·XIRR, 수익 기여와 비용 효과
- 여러 설정 비교, 시작일·비중·리밸런싱·현금흐름 민감도 분석

### 전략 연구와 최적화

![Portfolio Lens 전략 연구 화면](docs/readme/optimization.png)

- 최소·최대 비중, 필수·제외 종목, 최대 종목 수 제약 최적화
- 최대 Sharpe·Sortino·Calmar, 최소 변동성·CVaR 등 목적함수
- 위험·수익·회전율 기반 Pareto frontier
- Walk-forward train/OOS 검증과 비중 안정성
- 스트레스 구간과 다중 시나리오 비교
- 상관구조를 보존하는 moving-block bootstrap Monte Carlo
- 분산 후보, 시장 국면, 중복 자산, 수익 기여와 리밸런싱 계획 연구 도구
- seed를 고정한 결정적 후보 생성과 재현 가능한 결과

### MCP와 보고서

- 공식 TypeScript MCP SDK 기반 Streamable HTTP endpoint
- OAuth Authorization Code + PKCE와 scope 기반 도구 권한
- 포트폴리오·시장 데이터·백테스트·최적화·Monte Carlo 등 31개 MCP 도구
- 인자와 결과를 저장하지 않는 DB 기반 MCP 감사 로그
- 대용량 결과의 artifact/resource 외부화
- OpenAI 호환 API 또는 Amazon Bedrock을 이용한 선택적 AI 평가 보고서
- 보고서 JSON은 로컬 파일 또는 비공개 S3에 저장하고 고정 React 템플릿으로 렌더링

MCP는 기본적으로 비활성입니다. 연결 방법과 OAuth 설정은 [MCP와 ChatGPT 연결 가이드](docs/mcp-chatgpt.md)를 참고하세요.

## Rust를 사용하는 이유

웹 UI와 HTTP·인증·MCP 처리는 Node.js에 남기고, CPU 집약적인 계산은 Rust worker로 분리했습니다.

![Rust를 사용하는 이유](docs/readme/rust-why.png)

- 포트폴리오 최적화의 반복 후보 평가와 Monte Carlo 경로 생성을 Rayon으로 병렬 처리합니다.
- 백테스트의 현금·정수 수량·거래비용·현금흐름·XIRR을 하나의 타입 안전한 ledger에서 계산합니다.
- 계산 부하와 메모리 사용을 Express의 요청 처리 및 MCP control plane에서 격리합니다.
- 짧은 대화형 계산은 persistent Unix domain socket을 사용해 프로세스 시작 비용을 제거합니다.
- 장기 실행 작업은 PostgreSQL durable queue, lease, heartbeat와 recovery 경로를 선택할 수 있습니다.
- 고정 seed, 요청 hash, 엔진 버전과 데이터 revision을 함께 검증해 재현성을 유지합니다.

### 측정된 성능

아래 값은 저장소의 [벤치마크 원본](benchmarks/results/rust-ipc-benchmark-2026-07-18.json)에서 가져온 p50입니다.

| 작업 | Node.js 계산 | Rust 계산 | Rust UDS 왕복 | 결과 |
| --- | ---: | ---: | ---: | --- |
| 백테스트 | 41.372 ms | 41.050 ms | 77.080 ms | 계산 자체는 약 0.8% 빠른 동률 수준이며, IPC 포함 시 Node 계산보다 느림 |
| 최적화 | 5,877.547 ms | 90.999 ms | 118.688 ms | Rust 계산 64.589배, UDS 왕복 포함 49.521배 빠름 |

![Node.js, Python, Rust 성능 비교](docs/readme/rust-performance.png)

측정 환경은 Ryzen 5 5600G 12 logical cores, Node.js 22.14, Rust 1.97입니다. 1,260일·8자산과 1,000개의 결정적 후보 fixture를 사용했고 백테스트 10회, 최적화 3회를 측정했습니다.

UDS 왕복에는 Node JSON 직렬화, length-prefixed frame 전송, Rust decode·계산·encode와 Node parse가 포함됩니다. 시세 다운로드, DB 준비와 HTTP 왕복 시간은 포함하지 않습니다. 따라서 전체 애플리케이션이 49~65배 빨라졌다는 의미가 아니라, 이 fixture의 **반복 포트폴리오 최적화 경로**에서 얻은 가속입니다.

단일 백테스트에서 Rust의 주된 이점은 절대 속도보다 기능이 완전한 ledger, 결정적 실행과 Node event loop 격리입니다. 약 705KB의 백테스트 결과를 JSON으로 전달하는 직렬화 비용은 여전히 남아 있습니다. 상세 비교와 수치 동등성 결과는 [Rust 전환 보고서](docs/presentation/rust-migration-report.html)에서 확인할 수 있습니다.

## 구조

![Node.js control plane과 Rust worker 내부 구조](docs/readme/rust-architecture.png)

Node.js는 인증, 요청 검증, 시세·환율 준비, 캐시, run 상태, artifact, 보고서와 MCP 응답을 담당합니다. Rust는 백테스트 ledger, 최적화, Walk-forward, 스트레스·민감도와 Monte Carlo를 담당합니다.

기본 `rust_socket` 모드는 4-byte big-endian 길이와 JSON payload를 사용하는 Unix domain socket으로 통신합니다. 요청과 응답의 schema version, engine version, run ID, job kind, data revision과 request hash를 서로 대조합니다.

## 빠른 시작

### 요구 사항

- Docker
- Docker Compose v2
- 토스증권 Open API 자격증명 또는 읽기 전용 호환 API token

### Docker Compose

```bash
git clone <repository-url>
cd toss-portfolio-lens
cp .env.example .env
```

`.env`에서 웹 로그인과 세션 값을 먼저 설정합니다.

```dotenv
DASHBOARD_PASSWORD=replace-with-a-strong-password
SESSION_SECRET=replace-with-at-least-32-random-characters
```

토스증권 OAuth Client Credentials를 사용한다면 다음 값을 설정합니다.

```dotenv
TOSS_API_AUTH_MODE=oauth_client_credentials
TOSS_API_BASE_URL=https://openapi.tossinvest.com
CLIENT_ID=your-client-id
CLIENT_SECRET=your-client-secret
```

읽기 전용 호환 API를 사용한다면 OAuth 값 대신 다음을 설정합니다.

```dotenv
TOSS_API_AUTH_MODE=static_bearer
TOSS_API_BASE_URL=https://your-compatible-api.example.com
TOSS_API_BEARER_TOKEN=your-read-only-token
```

Node 웹 서버와 Rust UDS worker를 빌드해 실행합니다.

```bash
docker compose up --build -d
curl http://localhost:3200/api/health
```

브라우저에서 `http://localhost:3200`을 엽니다.

```bash
# 로그 확인
docker compose logs -f web compute-ipc

# 중지
docker compose down
```

기본 저장소는 SQLite이며 `portfolio_data` Docker volume에 저장됩니다. PostgreSQL과 MySQL/MariaDB 설정은 [.env.example](.env.example)에 있습니다. 외부 DB를 선택한 상태에서 연결이나 마이그레이션이 실패하면 다른 저장소로 자동 전환하지 않고 시작을 중단합니다.

### 로컬 개발

Docker 없이 개발하려면 Node.js 22와 Rust 1.97 toolchain이 필요합니다.

```bash
npm ci
npm run dev
```

- Web UI: `http://localhost:5173`
- Express API: `http://localhost:3200`
- Rust worker socket: `/tmp/toss-portfolio-lens-compute.sock`

`npm run dev`는 Vite, Express와 release Rust UDS worker를 함께 실행합니다. 명시적인 레거시 Node 계산 경로는 `npm run dev:legacy`로 실행할 수 있습니다.

## 실행 모드

| `EXECUTION_MODE` | 용도 | 요구 사항 |
| --- | --- | --- |
| `rust_socket` | 기본 로컬·단일 호스트 저지연 실행 | Rust UDS worker |
| `external` | 내구성 queue와 독립 worker | PostgreSQL |
| `inline` | 개발 호환·긴급 롤백용 Node 경로 | 추가 worker 없음 |

외부 worker 모드는 PostgreSQL에서만 사용할 수 있습니다.

```bash
EXECUTION_MODE=external docker compose --profile external-compute up --build -d --no-deps web compute-worker
```

Rust UDS 장애 시 데이터 volume을 유지한 채 inline으로 임시 전환할 수 있습니다.

```bash
EXECUTION_MODE=inline docker compose up -d --no-deps web
```

## 주요 환경 변수

| 변수 | 설명 |
| --- | --- |
| `DASHBOARD_PASSWORD` | 웹 로그인 비밀번호와 앱의 읽기 전용 API Bearer token |
| `SESSION_SECRET` | 로그인 세션 HMAC 서명 값, 32자 이상 |
| `TOSS_API_AUTH_MODE` | `oauth_client_credentials` 또는 `static_bearer` |
| `TOSS_API_BASE_URL` | 토스증권 또는 호환 API 주소 |
| `DB_PROVIDER` | `sqlite`, `postgresql`, `mysql` |
| `EXECUTION_MODE` | `rust_socket`, `external`, `inline` |
| `RUST_COMPUTE_*` | UDS socket, pool 크기와 timeout |
| `RUST_WORKER_*` | external worker poll, lease, heartbeat와 recovery |
| `MCP_ENABLED` | MCP endpoint 활성화 여부, 기본 `false` |
| `REPORT_AI_PROVIDER` | 선택적 보고서 provider, `openai` 또는 `bedrock` |
| `REPORTS_PATH` / `S3_*` | 보고서 JSON 저장 위치 |

전체 설정과 예시는 [.env.example](.env.example), MCP 전용 설정은 [.env.chatgpt.example](.env.chatgpt.example)을 참고하세요.

## 데이터와 보안 경계

- 브라우저에는 토스증권 자격증명, 업스트림 Bearer token과 DB 비밀번호를 전달하지 않습니다.
- 업스트림에는 계좌·보유자산·완료 체결·시세·종목·시장 지표의 조회 요청만 보냅니다.
- MCP 감사 로그에는 요청 인자, 결과와 OAuth token을 저장하지 않습니다.
- 수정주가의 기업행위 반영 범위는 데이터 공급자 정의를 따릅니다.
- 기본 분석은 KRW와 USD 자산을 지원합니다. JPY·EUR 등 다른 기준통화는 일반화되어 있지 않습니다.
- `currencyMode=KRW`는 과거 USD/KRW 환율을 반영하고, `local`은 환율 효과를 제외한 현지통화 수익률 연구용입니다.
- 캐시가 부족하면 실행 전에 공급자에서 보충합니다. 공급자가 전체 기간을 제공하지 못하면 실제 공통 기간이 요청보다 짧아질 수 있으므로 `effective_period`, 경고와 데이터 품질을 확인해야 합니다.

## 검증

```bash
npm run typecheck
npm test
npm run build
npm run test:rust-worker
npm run benchmark:rust-ipc
```

PostgreSQL 외부 worker 환경이 준비되어 있다면 다음 검증도 실행할 수 있습니다.

```bash
npm run test:postgres
npm run test:worker-queue
npm run test:rust-worker-postgres
```

README 화면은 실제 shadcn/ui 컴포넌트와 다크 테마를 사용하는 `/readme-showcase` 경로에서 Playwright로 캡처합니다.

Rust 설명 화면은 shadcn/ui의 다크 토큰과 무테두리 컴포넌트 구성을 적용한 정적 [HTML+JS 원본](docs/readme/rust-engine.html)에서 함께 생성합니다.

```bash
npm run docs:capture-readme
```

## 기술 스택

- React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui, Radix UI, Recharts
- Express 5, Zod, MCP TypeScript SDK
- Rust 1.97, Rayon, Tokio, Unix domain socket
- SQLite, PostgreSQL, MySQL/MariaDB
- Vitest, Playwright, Cargo test·clippy
- Docker Compose, Kubernetes, CloudFormation

## 추가 문서

- [MCP와 ChatGPT 연결](docs/mcp-chatgpt.md)
- [Rust 전환과 성능 보고서](docs/presentation/rust-migration-report.html)
- [AWS 배포 가이드](infra/aws/README.md)
- [홈랩 배포 가이드](infra/homelab/README.md)
