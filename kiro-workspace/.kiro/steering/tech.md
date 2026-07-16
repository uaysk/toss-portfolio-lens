---
inclusion: always
---

# Technology stack and constraints

## 애플리케이션

- Node.js 22, TypeScript strict mode, ESM
- React 19 + Vite 6
- Express 5 단일 서버: JSON API와 빌드된 SPA를 같은 프로세스에서 제공
- Tailwind CSS 3 + shadcn/ui/Radix UI 구성 패턴
- Recharts 기반 Area, Pie, Line, Composed/Candlestick 시각화
- Vitest 단위·통합 테스트
- SQLite 기본 저장소와 `mysql2` 기반 MySQL 호환 저장소
- AWS SDK for JavaScript v3의 S3 client
- 멀티스테이지 Dockerfile, 비루트 런타임 사용자
- Docker Compose에서 `0.0.0.0:3200` 노출

가능한 한 현재 주요 버전을 유지하되 구현 시점의 안정 버전과 보안 패치를 확인한다. 불필요한 전역 상태 라이브러리나 대규모 UI 프레임워크를 추가하지 않는다.

## 외부 연동

- 토스증권 Open API: 서버 간 OAuth 및 GET 조회만 사용
- OpenAI Responses API 호환 엔드포인트: `OPENAI_API_ENDPOINT`, `OPENAI_API_KEY`, 선택적 `OPENAI_MODEL`
- S3 또는 S3 호환 저장소: 보고서 JSON 전용
- MySQL 8 계열: AWS에서는 RDS MySQL을 목표로 한다.

## 시간·통화 규칙

- 서버와 브라우저 기본 시간대에 의존하지 않고 모든 거래일 계산에 `Asia/Seoul`을 명시한다.
- 원본 거래·가격 통화를 보존한다.
- 통합 평가 시 USD 값은 해당 KST 날짜의 USD/KRW 환율을 사용한다. 누락 환율은 명시된 직전 유효값 전달 규칙을 적용하고 데이터 품질 경고를 남긴다.
- 돈은 API 경계에서 숫자로 다루되, DB와 계산 계층에서는 부동소수점 오차가 성과를 왜곡하지 않도록 소수 정규화 또는 decimal 전략을 문서화한다.

## 품질 기준

- 모든 외부 입력을 런타임 검증하고 허용 쿼리를 화이트리스트로 제한한다.
- 네트워크 요청에 timeout, 취소, 의미 있는 오류 매핑을 적용한다.
- 파생 지표는 순수 함수로 구현하고 경계값·누락값·상수 시계열을 테스트한다.
- UI 데이터 요청은 언마운트·계좌 변경 시 취소하고 오래된 응답이 새 상태를 덮어쓰지 않게 한다.
- Docker build 단계에서 타입 검사, 테스트, 프로덕션 빌드를 모두 수행한다.

## AWS 배포 기술

- AWS CLI v2, Terraform 1.10 이상, AWS Provider의 구현 시점 안정 메이저
- 기본 리전 `ap-northeast-2`
- ECR private repository → ECS Fargate → Application Load Balancer
- RDS MySQL `db.t4g.small`, Single-AZ
- 비공개 S3 보고서 버킷, Secrets Manager, CloudWatch Logs
- S3 remote state + native `.tflock`; DynamoDB state lock은 사용하지 않는다.
- 로컬 Docker build는 `linux/amd64`로 고정해 ECS 런타임 아키텍처와 일치시킨다.
