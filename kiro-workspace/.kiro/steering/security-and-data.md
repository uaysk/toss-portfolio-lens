---
inclusion: always
---

# Security and data handling

## 비밀정보

- `CLIENT_ID`, `CLIENT_SECRET`, `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `OPENAI_API_KEY`, DB password는 서버에서만 읽는다.
- 브라우저 번들, API 응답, 보고서 JSON, 로그, 테스트 snapshot에 비밀값을 포함하지 않는다.
- `.env`, `*.tfvars`, Terraform plan/state, SQLite 파일, 생성 보고서 디렉터리를 Git에서 제외한다.
- AWS에서는 ECS task definition의 평문 `environment`가 아니라 Secrets Manager의 JSON key 주입을 사용한다.
- secret을 교체한 뒤에는 ECS 새 배포가 필요하다는 운영 절차를 문서화한다.

## 인증과 세션

- 웹 로그인은 `DASHBOARD_PASSWORD`를 일정 시간 비교한다.
- 로그인 성공 시 HMAC 서명된 HttpOnly, SameSite=Strict, Path=/ 쿠키를 발급하고 12시간 뒤 만료한다.
- HTTPS 요청에서는 Secure 속성을 적용한다.
- IP별 15분 동안 실패 5회 후 제한하며 성공 시 실패 카운터를 초기화한다.
- 이 앱의 토스 호환 읽기 전용 API는 `DASHBOARD_PASSWORD` 자체를 Bearer token으로 검증한다. 별도 장기 토큰을 생성하거나 저장하지 않는다.

## 데이터 분류

- 계좌 ID, 보유내역, 체결내역, 평가액, 보고서는 민감한 개인 금융 데이터다.
- 보고서에는 account ID를 저장하지 않는다.
- 보고서 URL은 UUID 기반 불투명 식별자를 사용하고 목록 API를 공개하지 않는다.
- 공개 보고서 응답에는 `Cache-Control: no-store`, `X-Robots-Tag: noindex, noarchive`를 적용한다.
- S3 object는 private이며 application task role만 지정 prefix를 읽고 쓸 수 있다.

## 데이터 정확성

- 토스 API가 제공하지 않는 계좌 입출금, 예수금, 배당 원장은 비어 있는 것으로 취급하지 말고 `unavailable`로 구분한다.
- 체결내역과 일봉으로 재구성한 수량·평가액·현금흐름은 추정치임을 표시한다.
- 현재 잔고와 누적 체결 수량이 다른 경우 입출고·액면분할 가능성을 경고하고 현재 보유량 기준 보정 내역을 기록한다.
- 매도 후 예수금은 원장이 없으면 포트폴리오 평가금에 임의로 추가하지 않는다.
- 분석 기여도는 부호가 있는 실제 값 내림차순으로 정렬한다. 절댓값으로 정렬하지 않는다.

## AWS 네트워크와 권한

- RDS는 public access를 끄고 ECS task security group에서 오는 3306만 허용한다.
- ECS task는 ALB security group에서 오는 3200만 허용한다.
- ALB 외에 task의 public IP로 직접 인바운드할 수 없어야 한다.
- task execution role은 ECR pull, CloudWatch log, 지정 secret read에만 사용한다.
- application task role은 보고서 S3 bucket의 지정 prefix에 대한 최소 read/write만 가진다.
- RDS와 S3는 암호화 at rest를 사용하고, 운영 도메인에는 HTTPS를 기본으로 한다.
