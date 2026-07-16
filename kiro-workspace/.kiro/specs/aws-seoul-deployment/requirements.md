# Requirements Document

## 1. 목적

이 Spec은 Toss Portfolio Lens 애플리케이션과 **별도 저장소**에서 AWS CLI와 Terraform 기반 배포 자동화를 구현한다. 애플리케이션 Docker 이미지는 사용자의 로컬 소스 디렉터리에서 빌드하고 Amazon ECR private repository에 push한 뒤 Amazon ECS가 그 digest를 실행한다.

이 Spec의 기본 실행 결과는 Terraform·운영 스크립트·문서 생성과 정적 검증이다. 실제 AWS 리소스 생성, 이미지 push, 서비스 변경은 별도의 명시적 승인과 실행 단계다.

## 2. 기본 의사결정

| 항목 | 기본값 | 근거 |
| --- | --- | --- |
| Region | `ap-northeast-2` | 서울 리전 |
| ECS launch type | Fargate | 인스턴스 관리 제거 |
| ECS task size | 1 vCPU / 2 GiB | 2 vCPU/2 GiB는 Fargate에서 유효하지 않은 조합이므로 가장 가까운 최소 비용 조합 |
| ECS scale-up profile | 2 vCPU / 4 GiB | 2 vCPU가 필요할 때의 최소 유효 조합 |
| ECS desired count | 1 | 개인용·최소 비용 |
| RDS | MySQL, `db.t4g.small` | 2 vCPU / 2 GiB |
| RDS topology | Single-AZ | 최소 비용 |
| RDS storage | 20 GiB gp3, max 50 GiB | 작은 시작 용량 + autoscaling |
| Reports | private S3 | Fargate ephemeral filesystem 회피 |
| Ingress | internet-facing ALB | 안정 endpoint, health check, TLS 확장 |
| NAT Gateway | 없음 | 고정 비용 절감 |
| Terraform state | 별도 encrypted/versioned S3 + native lockfile | 원격 state와 동시 실행 보호 |

## 3. 요구사항

### Requirement 1 — 독립 IaC 저장소와 안전한 실행 경계

**User story:** 애플리케이션 소스와 인프라 수명주기를 분리하고 실수로 배포하지 않길 원한다.

#### Acceptance criteria

1. THE DEPLOYMENT PROJECT SHALL 애플리케이션 저장소와 별도 디렉터리·Git 저장소로 생성된다.
2. THE DEPLOYMENT PROJECT SHALL 애플리케이션 소스나 `.env`를 복사하지 않고 `APP_SOURCE_DIR` 입력으로만 참조한다.
3. WHEN Kiro가 이 Spec을 구현하면 THE DEPLOYMENT PROJECT SHALL 기본적으로 파일 생성, `terraform fmt`, `terraform validate`, shell 정적 검사까지만 수행한다.
4. THE DEPLOYMENT PROJECT SHALL `terraform apply`, `terraform destroy`, `docker push`, ECR/ECS mutation을 사용자의 명시적 실행 없이는 호출하지 않는다.
5. WHEN mutation script를 실행하면 THE DEPLOYMENT PROJECT SHALL AWS account ID, profile, region, environment와 작업을 출력하고 정확한 확인 문자열을 요구한다.
6. THE DEPLOYMENT PROJECT SHALL 실제 secret, account-specific ARN, `.tfstate`, plan file, generated backend config를 Git에 포함하지 않는다.

### Requirement 2 — AWS CLI·Terraform 사전 점검

**User story:** 잘못된 계정이나 리전에 배포하기 전에 즉시 실패하고 싶다.

#### Acceptance criteria

1. THE DEPLOYMENT PROJECT SHALL AWS CLI v2, Terraform 1.10+, Docker buildx, jq의 존재와 버전을 점검한다.
2. WHEN AWS 작업을 준비하면 THE DEPLOYMENT PROJECT SHALL `aws sts get-caller-identity`로 account를 확인하고 예상 account ID와 다르면 중단한다.
3. THE DEPLOYMENT PROJECT SHALL 기본 region을 `ap-northeast-2`로 설정하고 실제 CLI·provider·ECR login이 같은 region을 사용하는지 검증한다.
4. THE DEPLOYMENT PROJECT SHALL 장기 access key 생성을 지시하지 않고 AWS IAM Identity Center/SSO 또는 단기 credential profile을 권장한다.
5. WHEN RDS instance class를 선택하면 THE DEPLOYMENT PROJECT SHALL `describe-orderable-db-instance-options`로 서울 리전에서 engine/version과 `db.t4g.small` 조합을 확인하는 preflight를 제공한다.
6. WHEN Docker 이미지를 빌드하면 THE DEPLOYMENT PROJECT SHALL Docker daemon, build context, Dockerfile과 `linux/amd64` builder 지원을 점검한다.

### Requirement 3 — Terraform remote state bootstrap

**User story:** Terraform state를 안전하게 보관하고 동시 apply를 막고 싶다.

#### Acceptance criteria

1. THE DEPLOYMENT PROJECT SHALL main Terraform과 독립된 AWS CLI bootstrap 절차로 globally unique state S3 bucket을 생성하거나 기존 bucket을 검증한다.
2. THE DEPLOYMENT PROJECT SHALL state bucket의 모든 public access block, SSE-S3 default encryption, versioning을 활성화한다.
3. THE DEPLOYMENT PROJECT SHALL state object key를 project/environment별로 분리하고 `use_lockfile=true`를 사용한다.
4. THE DEPLOYMENT PROJECT SHALL DynamoDB state lock table을 생성하지 않는다.
5. WHEN bootstrap을 다시 실행하면 THE DEPLOYMENT PROJECT SHALL 기존 설정을 파괴하지 않고 필요한 보안 설정만 idempotent하게 확인·보완한다.
6. THE DEPLOYMENT PROJECT SHALL backend partial configuration example을 제공하고 credential을 backend 파일에 넣지 않는다.

### Requirement 4 — VPC와 최소 비용 네트워크

**User story:** RDS는 외부에 노출하지 않으면서 NAT Gateway 비용을 피하고 싶다.

#### Acceptance criteria

1. THE INFRASTRUCTURE SHALL 서울 리전의 서로 다른 2개 가용영역에 각각 public subnet과 private DB subnet을 생성한다.
2. THE INFRASTRUCTURE SHALL internet gateway와 public route table을 생성하고 public subnet만 `0.0.0.0/0` route를 가진다.
3. THE INFRASTRUCTURE SHALL private DB subnet에 internet/NAT route를 만들지 않는다.
4. THE INFRASTRUCTURE SHALL NAT Gateway와 NAT instance를 기본 구성에 생성하지 않는다.
5. THE INFRASTRUCTURE SHALL ALB와 단일 Fargate task를 public subnet에 두고 task에 public IP를 할당해 Toss/OpenAI/ECR/S3 outbound를 허용한다.
6. THE INFRASTRUCTURE SHALL task security group의 inbound 3200을 ALB security group source로만 허용하고 인터넷 CIDR에서 직접 task로 들어오는 규칙을 만들지 않는다.
7. THE INFRASTRUCTURE SHALL RDS security group의 inbound 3306을 ECS task security group source로만 허용한다.
8. THE INFRASTRUCTURE SHALL ALB security group에 80과, HTTPS가 구성된 경우 443만 public inbound로 허용한다.
9. THE INFRASTRUCTURE SHALL IPv4 CIDR, subnet CIDR, availability zone 수를 변수화하되 overlap과 부족한 subnet 수를 validation으로 거부한다.

### Requirement 5 — ECR과 로컬 이미지 공급망

**User story:** 로컬에서 검증한 이미지를 immutable하게 ECR에 올리고 ECS가 정확한 이미지를 사용하길 원한다.

#### Acceptance criteria

1. THE INFRASTRUCTURE SHALL private ECR repository를 Terraform으로 생성하고 tag immutability와 push scan을 활성화한다.
2. THE INFRASTRUCTURE SHALL untagged image 정리와 최근 release image 최소 10개 보존 lifecycle policy를 제공한다.
3. WHEN build script를 실행하면 THE DEPLOYMENT PROJECT SHALL `APP_SOURCE_DIR`의 Dockerfile로 `linux/amd64` 이미지를 로컬 빌드하고 app typecheck/test/build 실패를 그대로 중단한다.
4. THE DEPLOYMENT PROJECT SHALL AWS CLI `ecr get-login-password`로 해당 서울 리전 registry에 로그인한다.
5. THE DEPLOYMENT PROJECT SHALL Git commit SHA 또는 명시적 release ID를 immutable tag로 사용하고 `latest`에 의존하지 않는다.
6. WHEN push가 끝나면 THE DEPLOYMENT PROJECT SHALL ECR에서 image digest를 조회하고 ECS 입력을 `repository_url@sha256:...` 형태로 pin한다.
7. THE DEPLOYMENT PROJECT SHALL ECR repository가 아직 없을 때 service 생성 전 repository를 준비하는 2단계 bootstrap workflow를 제공한다.
8. THE DEPLOYMENT PROJECT SHALL 실제 secret, `.env`, SQLite DB, report JSON, node_modules, Git metadata가 image layer/build context에 들어가지 않게 검증한다.

### Requirement 6 — 최소 비용 RDS MySQL

**User story:** 2코어/2GB 수준의 관리형 DB를 최소 비용으로 사용하고 싶다.

#### Acceptance criteria

1. THE INFRASTRUCTURE SHALL RDS MySQL instance class 기본값으로 2 vCPU/2 GiB인 `db.t4g.small`을 사용한다.
2. THE INFRASTRUCTURE SHALL Single-AZ, 20 GiB gp3, storage autoscaling max 50 GiB, public accessibility false를 기본으로 한다.
3. THE INFRASTRUCTURE SHALL storage encryption을 활성화하고 RDS가 관리하는 master user password와 Secrets Manager secret을 사용한다.
4. THE INFRASTRUCTURE SHALL DB subnet group에 두 private subnet을 사용한다.
5. THE INFRASTRUCTURE SHALL backup retention 기본 1일, maintenance/backup window, copy tags to snapshot을 설정한다.
6. THE INFRASTRUCTURE SHALL 비용 절감을 위해 Multi-AZ, read replica, Performance Insights, Enhanced Monitoring, 불필요한 log export를 기본 비활성화한다.
7. THE INFRASTRUCTURE SHALL `deletion_protection`, `skip_final_snapshot`, `final_snapshot_identifier`를 production-safe 변수로 제공하고 destroy 전에 명시적으로 바꾸게 한다.
8. THE INFRASTRUCTURE SHALL DB name, username, endpoint, port를 비밀이 아닌 ECS environment로 전달하고 password만 secret으로 주입한다.
9. THE INFRASTRUCTURE SHALL 애플리케이션에 `MYSQL_REQUIRED=true`를 설정해 AWS에서 RDS 실패 시 ephemeral SQLite로 조용히 fallback하지 않게 한다.
10. THE DEPLOYMENT PROJECT SHALL 현재 애플리케이션 이미지가 RDS TLS/CA와 `MYSQL_REQUIRED`를 지원하는지 preflight contract로 확인한다.

### Requirement 7 — ECS Fargate 서비스

**User story:** 서버 관리 없이 한 개의 저비용 태스크로 대시보드를 운영하고 싶다.

#### Acceptance criteria

1. THE INFRASTRUCTURE SHALL ECS cluster, task definition, Fargate service를 생성한다.
2. THE INFRASTRUCTURE SHALL task CPU 기본값 `1024`와 memory `2048`을 사용한다.
3. THE INFRASTRUCTURE SHALL 2 vCPU를 요청할 경우 memory가 최소 4096이 되도록 Terraform validation을 적용하고 2 vCPU/2 GiB를 허용하지 않는다.
4. THE INFRASTRUCTURE SHALL desired count 1, autoscaling off를 기본으로 하고 사용자가 명시적으로 활성화할 수 있게 한다.
5. THE INFRASTRUCTURE SHALL container를 `0.0.0.0:3200`, `NODE_ENV=production`으로 실행하고 port mapping 3200을 사용한다.
6. THE INFRASTRUCTURE SHALL health check grace period, ALB target health `/api/health`, deployment circuit breaker와 rollback을 설정한다.
7. THE INFRASTRUCTURE SHALL read-only root filesystem을 애플리케이션 호환 시 활성화하고 writable 임시 경로만 명시한다.
8. THE INFRASTRUCTURE SHALL `linux/amd64`, Fargate platform 1.4.0 이상을 사용해 JSON-key secret injection을 지원한다.
9. THE INFRASTRUCTURE SHALL 기본 20 GiB ephemeral storage를 사용하고 SQLite/report durability에 의존하지 않는다.
10. WHEN `enable_service=false`이면 THE INFRASTRUCTURE SHALL ECR·network·data resources를 준비하되 존재하지 않는 image로 ECS service를 시작하지 않는다.

### Requirement 8 — ALB, HTTPS와 선택적 DNS

**User story:** 안정적인 URL과 health-checked ingress로 애플리케이션과 보고서를 제공하고 싶다.

#### Acceptance criteria

1. THE INFRASTRUCTURE SHALL internet-facing Application Load Balancer와 IP target group을 생성한다.
2. THE INFRASTRUCTURE SHALL target group port 3200, HTTP health path `/api/health`, 성공 code 200을 사용한다.
3. WHEN `domain_name`과 기존 Route 53 hosted zone ID가 제공되면 THE INFRASTRUCTURE SHALL ACM certificate, DNS validation, ALB alias A/AAAA 또는 지원되는 record를 생성한다.
4. WHEN HTTPS가 구성되면 THE INFRASTRUCTURE SHALL 80을 443으로 redirect하고 modern TLS security policy를 사용한다.
5. WHEN domain이 없으면 THE INFRASTRUCTURE SHALL ALB DNS와 HTTP listener를 제공하되 production에는 HTTPS가 필요하다는 경고를 output/README에 표시한다.
6. THE INFRASTRUCTURE SHALL application environment `PUBLIC_APP_URL`을 HTTPS domain 또는 ALB URL과 일치시킨다.
7. THE INFRASTRUCTURE SHALL S3 static website/public report hosting을 사용하지 않고 모든 `/reports/*` 요청을 ECS 애플리케이션으로 전달한다.

### Requirement 9 — 비공개 S3 보고서 저장소

**User story:** Fargate 재시작 후에도 보고서를 보존하고 S3 object를 직접 공개하지 않길 원한다.

#### Acceptance criteria

1. THE INFRASTRUCTURE SHALL globally unique private report bucket을 Terraform으로 생성한다.
2. THE INFRASTRUCTURE SHALL 네 가지 bucket-level public access block, BucketOwnerEnforced object ownership, SSE-S3 default encryption을 적용한다.
3. THE INFRASTRUCTURE SHALL insecure transport를 거부하는 bucket policy를 적용한다.
4. THE INFRASTRUCTURE SHALL incomplete multipart upload 정리 lifecycle을 적용하고 report expiration은 기본 비활성화한다.
5. THE INFRASTRUCTURE SHALL `S3_BUCKET`, `S3_REGION`, `S3_PREFIX`를 task environment에 설정하고 static access key를 설정하지 않는다.
6. THE INFRASTRUCTURE SHALL application task role에 지정 prefix의 `GetObject`, `PutObject`와 필요한 최소 bucket metadata 권한만 부여한다.
7. THE INFRASTRUCTURE SHALL public-read ACL, wildcard principal, S3 website endpoint를 만들지 않는다.
8. THE INFRASTRUCTURE SHALL bucket destroy를 기본적으로 막고 data 삭제는 명시적 변수와 별도 확인을 요구한다.

### Requirement 10 — Secrets Manager와 구성 주입

**User story:** 자격증명을 Terraform state와 task definition 평문에서 분리하고 싶다.

#### Acceptance criteria

1. THE INFRASTRUCTURE SHALL app secret container만 Terraform으로 만들고 secret value를 Terraform resource/variable/state로 관리하지 않는다.
2. THE DEPLOYMENT PROJECT SHALL AWS CLI로 app secret 값을 생성·갱신하는 interactive script를 제공한다.
3. THE APP SECRET SHALL `CLIENT_ID`, `CLIENT_SECRET`, `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `OPENAI_API_ENDPOINT`, `OPENAI_API_KEY`, 선택적 `OPENAI_MODEL` JSON key를 지원한다.
4. THE DEPLOYMENT PROJECT SHALL prompt 값을 shell trace, command output, process list, world-readable temp file에 노출하지 않는다.
5. THE INFRASTRUCTURE SHALL ECS task execution role에 app secret과 RDS managed secret의 `GetSecretValue`만 허용한다.
6. THE INFRASTRUCTURE SHALL task definition `secrets`에서 JSON key별로 환경 변수에 주입한다.
7. THE DEPLOYMENT PROJECT SHALL secret value가 준비되지 않은 경우 ECS service 활성화를 거부하는 preflight를 제공한다.
8. THE DEPLOYMENT PROJECT SHALL secret rotation 후 `aws ecs update-service --force-new-deployment` 또는 Terraform 새 배포가 필요함을 문서화한다.
9. THE DEPLOYMENT PROJECT SHALL AWS access key를 app secret에 넣지 않고 task role을 사용한다.

### Requirement 11 — IAM 최소 권한 분리

**User story:** 컨테이너 agent 권한과 애플리케이션 권한을 분리하고 싶다.

#### Acceptance criteria

1. THE INFRASTRUCTURE SHALL ECS task execution role과 application task role을 서로 다른 IAM role로 생성한다.
2. THE EXECUTION ROLE SHALL ECR image pull, CloudWatch Logs write, 지정 Secrets Manager read에 필요한 권한만 가진다.
3. THE APPLICATION ROLE SHALL report bucket 지정 prefix에 필요한 S3 권한만 가진다.
4. THE INFRASTRUCTURE SHALL IAM action 또는 resource에 `*`가 필요한 경우 이유와 제한 condition을 코드 주석과 README에 설명한다.
5. THE INFRASTRUCTURE SHALL application container에 Terraform operator 권한, ECR push 권한, Secrets Manager read 권한을 제공하지 않는다.
6. THE DEPLOYMENT PROJECT SHALL local deploy principal에 필요한 최소 AWS API 목록을 문서화하고 root user 사용을 금지한다.

### Requirement 12 — 로그, 상태, 배포 안전성

**User story:** 작은 비용으로 장애 원인을 확인하고 실패 배포를 자동으로 되돌리고 싶다.

#### Acceptance criteria

1. THE INFRASTRUCTURE SHALL CloudWatch log group을 생성하고 retention 기본 7일, encryption 기본 AWS managed를 사용한다.
2. THE INFRASTRUCTURE SHALL ECS `awslogs` driver와 non-blocking 또는 구현 시점 권장 설정을 사용한다.
3. THE INFRASTRUCTURE SHALL ECS deployment circuit breaker rollback과 ALB health grace period를 사용한다.
4. THE DEPLOYMENT PROJECT SHALL 배포 후 ECS service stable, running task count, target health, `/api/health`, login page HTTP 상태를 검증한다.
5. THE DEPLOYMENT PROJECT SHALL 이전 정상 image digest를 기록하고 그 digest로 되돌리는 rollback script를 제공한다.
6. THE DEPLOYMENT PROJECT SHALL CloudWatch alarm을 기본 최소 세트(ALB unhealthy host, ECS running task 부족)로 선택 가능하게 하고 SNS는 opt-in으로 둔다.
7. THE DEPLOYMENT PROJECT SHALL 로그와 명령 출력에서 secret과 금융 payload를 노출하지 않는다.

### Requirement 13 — 2단계 배포 workflow

**User story:** ECR이 없는 첫 배포와 이후 업데이트를 같은 절차로 안전하게 처리하고 싶다.

#### Acceptance criteria

1. THE DEPLOYMENT PROJECT SHALL bootstrap, infrastructure prepare, secret populate, build/push, service apply, verify의 순서를 문서화한다.
2. WHEN 최초 배포하면 THE DEPLOYMENT PROJECT SHALL `enable_service=false`로 ECR과 기반 리소스를 먼저 준비한다.
3. WHEN ECR이 준비되면 THE DEPLOYMENT PROJECT SHALL 로컬 image를 build/push하고 digest를 release manifest에 기록한다.
4. WHEN app secret과 image digest가 모두 검증되면 THE DEPLOYMENT PROJECT SHALL `enable_service=true`와 pinned digest로 full plan/apply를 수행할 수 있다.
5. WHEN 후속 배포하면 THE DEPLOYMENT PROJECT SHALL 새 immutable tag/digest를 push하고 Terraform task definition revision만 변경한다.
6. THE DEPLOYMENT PROJECT SHALL saved binary plan을 apply할 수 있게 하고 plan 생성 이후 account/region/workspace mismatch를 확인한다.
7. THE DEPLOYMENT PROJECT SHALL 동일 digest 재배포가 불필요한 task churn을 만들지 않게 한다.
8. THE DEPLOYMENT PROJECT SHALL 실제 실행 명령과 되돌리기 명령을 README runbook으로 제공한다.

### Requirement 14 — 기존 SQLite 데이터 이전 경계

**User story:** 필요하면 기존 로컬 history를 RDS로 옮기되 자동으로 민감 DB 파일을 업로드하지 않길 원한다.

#### Acceptance criteria

1. THE DEPLOYMENT PROJECT SHALL 새 AWS 배포가 기본적으로 빈 RDS에서 시작하며 다른 호스트의 SQLite가 자동 이동되지 않는다고 명시한다.
2. THE DEPLOYMENT PROJECT SHALL 기존 SQLite migration을 명시적 opt-in 별도 runbook으로 제공한다.
3. THE DEPLOYMENT PROJECT SHALL SQLite 파일을 Docker image, Terraform state, 일반 report prefix에 포함하지 않는다.
4. WHEN migration을 수행한다면 THE DEPLOYMENT PROJECT SHALL 임시 private encrypted S3 object와 one-off ECS task 또는 동등한 private 경로를 사용하고 완료 후 object 삭제·권한 회수를 검증한다.
5. THE DEPLOYMENT PROJECT SHALL migration 전 RDS snapshot, table row count, application health를 기록하고 idempotent migration을 사용한다.
6. THE DEPLOYMENT PROJECT SHALL 이 optional migration을 사용자의 별도 승인 없이는 실행하지 않는다.

### Requirement 15 — 비용 제어와 명시적 절충

**User story:** 필수 기능을 유지하면서 예측하지 못한 AWS 비용을 피하고 싶다.

#### Acceptance criteria

1. THE INFRASTRUCTURE SHALL 공통 tag와 비용 분석용 `Project`, `Environment`, `ManagedBy` tag를 모든 지원 resource에 적용한다.
2. THE INFRASTRUCTURE SHALL NAT Gateway, Multi-AZ RDS, read replica, ECS autoscaling, WAF, ALB access log, custom KMS key, Performance Insights를 기본 비활성화한다.
3. THE INFRASTRUCTURE SHALL Fargate desired count 1과 RDS `db.t4g.small`을 기본값으로 유지한다.
4. THE DEPLOYMENT PROJECT SHALL ALB와 RDS가 단일 태스크보다 큰 고정 비용이 될 수 있음을 README에 명시한다.
5. THE DEPLOYMENT PROJECT SHALL AWS Pricing Calculator 확인 항목과 budget alarm 권장 절차를 제공하되 비용 숫자를 hard-code하지 않는다.
6. THE INFRASTRUCTURE SHALL storage, log retention, image retention, desired count에 validation과 보수적 기본값을 둔다.
7. THE DEPLOYMENT PROJECT SHALL Fargate Spot을 opt-in 변수로만 제공하고 interruption과 단일 태스크 downtime 위험을 설명한다.

### Requirement 16 — Terraform 품질과 검증

**User story:** apply 전에 IaC 오류와 보안 실수를 자동으로 찾고 싶다.

#### Acceptance criteria

1. THE DEPLOYMENT PROJECT SHALL Terraform version/provider constraint와 lock file 정책을 제공한다.
2. THE DEPLOYMENT PROJECT SHALL typed variables, descriptions, validation, sensitive marking과 stable outputs를 사용한다.
3. THE DEPLOYMENT PROJECT SHALL `terraform fmt -check -recursive`, `terraform init -backend=false`, `terraform validate`를 통과한다.
4. THE DEPLOYMENT PROJECT SHALL `shellcheck` 가능한 POSIX/Bash script와 `set -Eeuo pipefail`을 사용한다.
5. THE DEPLOYMENT PROJECT SHALL Checkov 또는 tfsec 중 하나의 optional static security command를 문서화한다.
6. THE DEPLOYMENT PROJECT SHALL test fixture 또는 `terraform test`로 Fargate 2 vCPU/2 GiB 거부, region default, public RDS 금지, S3 public block, IAM role 분리를 검증한다.
7. THE DEPLOYMENT PROJECT SHALL example tfvars/backend 파일에 secret이 없는지 자동 검사한다.
8. THE DEPLOYMENT PROJECT SHALL 실제 apply 없이 예상 리소스 목록과 data flow를 README에서 검토 가능하게 한다.
