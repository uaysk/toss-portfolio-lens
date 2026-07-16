# Workspace execution rules

이 워크스페이스에는 서로 다른 두 구현 대상이 있다. 한 번에 사용자가 지정한 Spec만 구현하고, 애플리케이션 코드와 AWS 인프라 코드를 서로 다른 저장소 경계로 유지한다.

## 공통 규칙

- 구현 전 해당 Spec의 `requirements.md`, `design.md`, `tasks.md` 전체를 읽는다.
- 각 작업의 완료 조건과 연결된 Requirement 번호를 유지한다.
- 비밀값을 예제, 테스트 fixture, 로그, 스크린샷, Terraform state에 기록하지 않는다.
- 환경 변수 예시는 비어 있거나 명백한 자리표시자만 사용한다.
- 읽기 전용이라는 제품 경계를 우회하거나 확장하지 않는다.
- 날짜 계산과 일별 집계는 `Asia/Seoul`을 명시적으로 사용한다.
- 국내 주식과 해외 주식은 분석·비중 차트에서 같은 원화 기준 시계열로 표현하되, 원본 통화와 환율 적용 여부를 데이터에 보존한다.
- 실제 데이터가 없는 지표를 사실처럼 표시하지 않는다. 추정값에는 근거와 한계를 함께 노출한다.
- 테스트, 타입 검사, 빌드가 모두 통과해야 작업을 완료로 표시한다.

## 애플리케이션 Spec 규칙

- 토스증권 API는 GET 조회만 호출한다.
- 브라우저에 `CLIENT_ID`, `CLIENT_SECRET`, OpenAI 키, AWS 자격증명을 전달하지 않는다.
- WTS 거래내역 붙여넣기 또는 HTML 가져오기 기능은 최종 제품 범위에서 제거된 기능이므로 다시 만들지 않는다.
- UI는 shadcn/ui 패턴, 다크 기본 테마, 라이트 전환, 무채색 표면, 외곽선과 그라데이션 없는 스타일을 유지한다. 차트 계열 식별 색만 유채색을 쓸 수 있다.

## AWS 배포 Spec 규칙

- AWS 리전 기본값은 `ap-northeast-2`로 고정하고 다른 리전은 명시적 변수 변경만 허용한다.
- 인프라 코드는 애플리케이션 저장소와 분리한다. 로컬 애플리케이션 디렉터리를 입력으로 받아 Docker 이미지를 빌드할 뿐, 앱 소스에 Terraform을 섞지 않는다.
- 기본 구현 단계에서는 `terraform fmt`, `terraform validate`, 정적 검사까지만 수행한다.
- `aws ... create/update/delete`, `docker push`, `terraform apply/destroy`, ECS 강제 배포는 사용자의 별도 승인 없이 실행하지 않는다.
- AWS CLI는 SSO 또는 단기 자격증명을 사용한다. 장기 키를 파일에 생성하지 않는다.
- Secrets Manager에는 사용자가 AWS CLI로 값을 넣고 Terraform에는 secret ARN만 전달한다.
- ECS task execution role과 application task role을 분리하고 최소 권한을 적용한다.
- S3 보고서 버킷은 퍼블릭 액세스를 모두 차단하며 보고서는 애플리케이션을 통해서만 제공한다.
