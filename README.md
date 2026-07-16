# Portfolio Lens

토스증권 호환 조회 API의 계좌·체결·시세 데이터를 일별 포트폴리오로 복원하고, 성과 분석·백테스트·AI 평가 보고서까지 하나의 화면에서 제공하는 읽기 전용 투자 대시보드입니다.

> 현재 AWS 데모: [EKS에서 실행 중인 Portfolio Lens](http://k8s-portfoli-portfoli-c955ab91b2-b83d97e1505d6fca.elb.ap-northeast-2.amazonaws.com)
>
> 이 NLB 엔드포인트는 **HTTP 데모**입니다. 브라우저와 서버 사이의 로그인 정보가 암호화되지 않으므로, ACM 인증서와 사용자 도메인으로 HTTPS를 구성하기 전에는 실제 비밀번호를 입력하지 마세요.

![Portfolio Lens 대시보드](docs/presentation/generated/app-overview.png)

## 무엇을 해결하나요?

- 국내·해외 주식을 한 포트폴리오로 합쳐 일별 평가금과 종목별 비중을 복원합니다.
- 포트폴리오 OHLC, TWR·XIRR, MDD, Sharpe·Sortino, VaR·CVaR, 집중도·기여도·상관관계 등 성과와 위험을 함께 분석합니다.
- KOSPI·KOSDAQ·Nasdaq 100·S&P 500 또는 개별 종목을 벤치마크로 비교합니다.
- 현재 보유 종목을 그대로 불러오거나 국내 6자리 코드와 미국 티커를 조합해 백테스트합니다.
- 계산된 지표를 Amazon Bedrock의 Kimi K2.5가 평가하고, 모든 보고서를 동일한 React 템플릿으로 렌더링합니다.
- 주문 생성·정정·취소 기능은 구현하지 않았고, 허용된 조회 요청만 업스트림으로 전달합니다.

## 제품 화면

### 자산 구성과 일별 비중

스택 영역의 전체 높이는 포트폴리오 평가금에 따라 변하고, 각 영역은 종목별 평가 비중을 나타냅니다. 날짜 범위를 일 단위로 지정할 수 있으며 현재 보유하지 않는 과거 종목도 함께 복원합니다.

![자산 구성과 보유 종목](docs/presentation/generated/app-account-composition.png)

### 포트폴리오 분석

전체 평가금을 일봉 형태로 표시하고 비교 지수의 시작점을 같은 날짜에 맞춥니다. 벤치마크 수치, 위험 조정 성과, 낙폭, 기여도, 집중도와 데이터 신뢰도를 한 화면에서 확인할 수 있습니다.

![포트폴리오 분석과 벤치마크](docs/presentation/generated/app-analysis.png)

### 포트폴리오 백테스트

현재 포트폴리오를 불러오거나 국내·해외 종목을 직접 추가할 수 있습니다. 종목을 삭제해도 다른 종목의 입력 비중은 자동 변경되지 않으며, 가장 늦게 상장한 종목의 상장일이 기본 시작일이 됩니다.

![백테스트 종목과 비중 설정](docs/presentation/generated/app-backtest.png)

초기 투자금·정기 현금흐름·리밸런싱·벤치마크·무위험수익률·거래비용 가정을 고정하고, 성장 경로와 위험·기여도·상관관계를 같은 조건으로 재현합니다.

![백테스트 결과와 AI 보고서](docs/presentation/generated/app-backtest-result.png)

### 실제 AI 평가 보고서

동일한 6개 ETF와 목표 비중, 초기 투자금 **₩10,000,000**, 요청 기간 `2025-03-01~2026-07-15`를 사용해 실제 수정주가 백테스트를 다시 실행하고 Amazon Bedrock의 Kimi K2.5 평가를 생성했습니다. 보고서 JSON은 비공개 S3에 저장되며 아래 화면은 애플리케이션의 고정 React 보고서 템플릿을 전체 페이지로 캡처한 결과입니다.

![실제 백테스트 AI 평가 보고서](docs/presentation/generated/app-report-example.png)

## 발표용 시연 포트폴리오

README의 애플리케이션 화면은 실제 계좌가 아닌 아래의 예시 포트폴리오를 사용했습니다. 그래프는 각 ETF의 실제 수정주가를 반영하며, 시작 평가금은 **₩10,000,000**, 비중 합계는 **100%**입니다.

| 종목 | 통화·시장 | 코드 | 상장일 | 목표 비중 |
| --- | --- | --- | --- | ---: |
| KODEX 200 | KRW · KOSPI | `069500` | 2002-10-14 | 20% |
| KODEX 반도체 | KRW · KOSPI | `091160` | 2006-06-27 | 20% |
| KODEX 미국반도체 | KRW · KOSPI | `390390` | 2021-06-30 | 15% |
| TIGER 글로벌멀티에셋TIF액티브 | KRW · KOSPI | `440340` | 2022-08-30 | 15% |
| KODEX 미국나스닥100 | KRW · KOSPI | `379810` | 2021-04-09 | 10% |
| TIME 미국나스닥100액티브 | KRW · KOSPI | `426030` | 2022-05-11 | 20% |

그래프 요청 기간은 `2025-03-01~2026-07-15`이며, 3월 1일 이후 첫 공통 거래일인 `2025-03-04`부터 총 335개 일봉을 계산했습니다. 화면 캡처 정보는 [발표 자료 가이드](docs/presentation/README.md)에 정리되어 있습니다.

## AWS 배포 구조

![AWS 런타임 아키텍처](docs/presentation/generated/aws-runtime-architecture.png)

| 영역 | 실제 구성 |
| --- | --- |
| 애플리케이션 | 서울 `ap-northeast-2`의 Amazon EKS 1.36, 관리형 노드 그룹 `t3.small` 1대, Kubernetes Deployment 1 replica |
| 컨테이너 | 로컬에서 `linux/amd64` 이미지를 빌드하고 Amazon ECR에 푸시한 뒤 EKS가 해당 이미지를 사용 |
| 외부 진입점 | AWS Load Balancer Controller가 생성한 인터넷 공개 NLB, 현재 HTTP 80 → Pod 3200 |
| 데이터베이스 | 격리 서브넷의 Amazon RDS for MariaDB 11.8.8, `db.t4g.small`, 20 GiB gp3, Single-AZ |
| 보고서 저장 | 버전 관리와 SSE-S3를 적용한 비공개 Amazon S3 객체(JSON) |
| AI 평가 | 스톡홀름 `eu-north-1`의 Amazon Bedrock, `moonshotai.kimi-k2.5` |
| AWS 권한 | EKS Pod Identity로 애플리케이션 Pod에 지정 S3 prefix와 Kimi 모델의 최소 권한만 부여 |
| 비밀 관리 | RDS 관리형 비밀번호는 AWS Secrets Manager에 보관하고, 배포 시 대시보드·세션·업스트림 토큰과 함께 Kubernetes Secret으로 주입 |

비용을 줄이기 위해 단일 EKS 노드와 Single-AZ RDS를 사용합니다. 이는 고가용성 구성이 아니며 운영 환경에서는 다중 노드, RDS Multi-AZ, HTTPS listener와 사용자 도메인을 추가해야 합니다.

다이어그램에는 AWS가 배포한 [공식 AWS Architecture Icons](https://aws.amazon.com/architecture/icons/)를 사용했습니다.

## 조회 API와 AI 보고서 흐름

![조회 API와 보고서 생성 흐름](docs/presentation/generated/api-report-flow.png)

### 조회 전용 포트폴리오

1. 브라우저는 HMAC 서명된 HttpOnly 세션 쿠키로 Express API를 호출합니다.
2. 서버는 Kubernetes Secret의 정적 Bearer 토큰으로 `https://tpl.uaysk.com/`의 토스증권 호환 읽기 전용 API를 호출합니다.
3. 국내·해외 종목, 체결, 일봉과 환율을 KRW 기준 포트폴리오 시계열로 정규화합니다.
4. 스냅샷·주문·가격·환율·분석 캐시는 RDS MariaDB에 저장합니다.

AWS 배포에서 `https://tpl.uaysk.com/`은 **토스증권 데이터 업스트림 API 엔드포인트**입니다. 사용자의 브라우저가 이 주소를 직접 호출하지 않으며, 계좌 식별자와 Bearer 토큰은 서버 내부에만 유지됩니다.

노출하는 호환 경로는 계좌·보유자산·체결 완료 주문·시세·종목·시장 지표의 `GET` 요청뿐입니다. 주문 가능 금액, 주문 생성·정정·취소와 조건주문 경로는 애플리케이션에서 제외합니다.

```bash
curl 'https://tpl.uaysk.com/api/v1/orders?status=CLOSED&limit=100' \
  -H 'Authorization: Bearer YOUR_DASHBOARD_PASSWORD' \
  -H 'X-Tossinvest-Account: ACCOUNT_SEQ'
```

### AI 평가 보고서

1. 분석 또는 백테스트의 기간·종목·비중·운용 조건을 서버에서 다시 계산합니다.
2. 수익률·위험·벤치마크·집중도·기여도·비용·데이터 품질 지표를 JSON으로 구성하고 계좌 식별자를 제거합니다.
3. EKS Pod가 Bedrock Converse API로 Kimi K2.5를 호출해 종합 점수, 강점, 위험과 점검 항목을 생성합니다.
4. 응답을 애플리케이션 스키마로 검증한 뒤 **비공개 S3에 JSON만 저장**합니다.
5. `/reports/{id}` 요청 시 서버가 JSON을 읽고 고정된 `portfolio-report-v1` React 템플릿으로 렌더링합니다. LLM이 HTML이나 디자인을 생성하지 않으므로 보고서마다 시각 구조가 달라지지 않습니다.

S3 객체는 public-read가 아니며, 보고서 ID 목록도 외부에 노출하지 않습니다. 다만 개별 보고서에는 실제 평가액과 성과가 포함될 수 있으므로 보고서 URL은 비밀번호처럼 취급해야 합니다.

## 보안 경계

- 브라우저에는 토스증권 자격증명, 업스트림 Bearer 토큰, RDS 비밀번호와 AWS 자격 증명이 전달되지 않습니다.
- 앱의 S3·Bedrock 권한은 장기 Access Key 대신 EKS Pod Identity로 제공합니다.
- RDS는 `require_secure_transport=1`이며, AWS global RDS CA bundle을 Pod에 마운트해 서버 인증서 체인을 검증합니다.
- RDS는 인터넷 경로가 없는 격리 서브넷에 있고 MariaDB 3306은 EKS 노드 보안 그룹에서만 접근할 수 있습니다.
- S3는 퍼블릭 액세스를 차단하고 암호화·버전 관리를 적용합니다.
- ECR은 immutable tag, push scan과 수명 주기 정책을 사용합니다.
- 로그인은 연결 원본 주소별 실패 횟수를 제한하고, 세션 쿠키는 HttpOnly·SameSite=Strict로 설정합니다. 외부 URL이 HTTPS이면 `Secure` 속성도 강제합니다.

## 로컬 실행

요구 사항은 Docker와 Docker Compose입니다. 애플리케이션과 호스트 모두 `0.0.0.0:3200`을 사용합니다.

```bash
cp .env.example .env
# .env에 DASHBOARD_PASSWORD, SESSION_SECRET과 데이터 소스 설정 입력
docker compose up --build -d web
curl http://localhost:3200/api/health
```

기본 데이터베이스는 SQLite입니다. 완전하고 유효한 MySQL 설정이 있으면 MySQL을 사용하고, 기존 SQLite 데이터를 안전하게 마이그레이션합니다. 로컬 AI 보고서는 OpenAI 호환 엔드포인트를, AWS 배포는 Bedrock을 선택할 수 있습니다.

주요 환경 변수:

| 변수 | 역할 |
| --- | --- |
| `DASHBOARD_PASSWORD` | 웹 로그인 비밀번호이자 이 앱이 노출하는 읽기 전용 호환 API의 Bearer 토큰 |
| `SESSION_SECRET` | 로그인 세션 HMAC 서명 값 |
| `TOSS_API_AUTH_MODE` | 실제 토스 OAuth는 `oauth_client_credentials`, 호환 API는 `static_bearer` |
| `TOSS_API_BASE_URL` | AWS 배포에서는 `https://tpl.uaysk.com/` |
| `PUBLIC_APP_URL` | 보고서 링크에 사용할 최종 외부 주소 |
| `REPORT_AI_PROVIDER` | `openai` 또는 `bedrock` |
| `MYSQL_*` | 선택적 MySQL 연결, TLS와 CA 검증 설정 포함 |
| `S3_*` | 선택적 비공개 보고서 저장소 설정 |

전체 예시는 [.env.example](.env.example)을 참고하세요.

## AWS에 재배포

AWS CLI, Docker, kubectl, Helm, jq, curl과 필요한 IAM 권한을 준비한 뒤 프로젝트 루트에서 실행합니다.

```bash
./infra/aws/deploy.sh
```

배포 스크립트는 다음 과정을 멱등적으로 수행합니다.

1. CloudFormation으로 VPC·EKS·ECR·RDS·S3·IAM을 생성 또는 갱신합니다.
2. AWS Load Balancer Controller와 EKS Pod Identity를 구성합니다.
3. RDS 관리형 비밀번호와 공식 CA bundle을 Pod 설정에 주입합니다.
4. 로컬 이미지를 빌드·검사해 ECR로 푸시하고 Deployment를 롤아웃합니다.
5. NLB의 `/api/health`가 `mysql`, `s3`, AI `configured`를 모두 보고할 때 완료합니다.

```bash
kubectl --context toss-portfolio-lens -n portfolio-lens get deploy,pod,svc
kubectl --context toss-portfolio-lens -n portfolio-lens rollout status deploy/portfolio-lens
```

리소스 사양, 변수, 운영상 주의점과 안전한 정리 순서는 [AWS 배포 가이드](infra/aws/README.md)에 있습니다.

## 기술 구성

- React, TypeScript, Vite, shadcn/ui, Recharts
- Express, Vitest, Playwright
- SQLite / MySQL·MariaDB
- Docker, Kubernetes, CloudFormation
- Amazon EKS, ECR, RDS, S3, Secrets Manager, Bedrock, NLB

## 검증

```bash
npm run typecheck
npm test
npm run build
```

발표용 화면은 Playwright로 같은 데이터와 뷰포트에서 재현하며, 생성 원본은 `docs/presentation/generated/`에 보관합니다. 토스증권 호환 API의 정확한 요청·응답 형식은 [토스증권 Open API 문서](https://developers.tossinvest.com/docs)를 기준으로 합니다.
