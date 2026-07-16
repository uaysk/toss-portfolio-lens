---
inclusion: always
---

# Project structure

## 저장소 경계

두 Spec은 하나의 Kiro 워크스페이스에 들어 있지만 최종 산출물은 별도 저장소로 유지한다.

```text
toss-portfolio-lens/       # 애플리케이션 저장소
toss-portfolio-lens-aws/   # AWS IaC 및 운영 스크립트 저장소
```

AWS 저장소는 애플리케이션 코드를 복사하지 않는다. 이미지 빌드 스크립트가 `APP_SOURCE_DIR`로 로컬 애플리케이션 저장소를 참조한다.

## 애플리케이션 권장 구조

```text
toss-portfolio-lens/
├── src/
│   ├── components/
│   │   ├── ui/
│   │   ├── dashboard/
│   │   ├── analysis/
│   │   ├── backtest/
│   │   └── reports/
│   ├── lib/
│   ├── types/
│   ├── App.tsx
│   └── main.tsx
├── server/
│   ├── api/
│   ├── auth/
│   ├── toss/
│   ├── history/
│   ├── analysis/
│   ├── backtest/
│   ├── reports/
│   ├── storage/
│   ├── env.ts
│   └── index.ts
├── scripts/
├── data/                 # gitignored runtime data
├── Dockerfile
├── compose.yaml
├── .dockerignore
├── .env.example
└── README.md
```

- API transport, 외부 토스 응답 매핑, 저장소, 계산 엔진, UI 표현을 분리한다.
- 범용 계산은 `server/analysis` 또는 `server/backtest`의 순수 함수에 둔다.
- 브라우저 전용 표시 계산은 `src/lib`에 두고 동일 파일 옆에 테스트를 둔다.
- shadcn primitives는 `src/components/ui`에 두고 도메인 화면은 이를 조합한다.
- 순환 import를 만들지 않으며 서버 코드가 브라우저 모듈을 import하지 않는다.

## AWS IaC 권장 구조

```text
toss-portfolio-lens-aws/
├── envs/
│   ├── production.backend.hcl.example
│   └── production.tfvars.example
├── scripts/
│   ├── lib.sh
│   ├── preflight.sh
│   ├── bootstrap-state.sh
│   ├── put-app-secret.sh
│   ├── build-and-push.sh
│   ├── plan.sh
│   ├── deploy.sh
│   ├── verify.sh
│   ├── rollback.sh
│   └── migrate-sqlite.md
├── tests/
│   └── defaults.tftest.hcl
├── versions.tf
├── providers.tf
├── variables.tf
├── locals.tf
├── networking.tf
├── ecr.tf
├── s3.tf
├── rds.tf
├── iam.tf
├── ecs.tf
├── alb.tf
├── dns.tf
├── monitoring.tf
├── outputs.tf
├── .gitignore
└── README.md
```

- Terraform 파일은 리소스 도메인별로 나누되 하나의 root module로 유지한다.
- shell 스크립트는 `set -Eeuo pipefail`, 명시적 환경 변수 검증, 민감값 비출력을 사용한다.
- 예제 파일에는 실 secret이나 계정 ID를 넣지 않는다.
- 생성 리소스에는 `Project`, `Environment`, `ManagedBy`, `Owner` 공통 태그를 적용한다.
