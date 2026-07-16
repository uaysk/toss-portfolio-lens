# Implementation Plan

## 실행 모드

이 작업 목록은 **별도 `toss-portfolio-lens-aws` 저장소**에서 실행한다. 기본 완료 범위는 IaC·스크립트·문서 생성과 정적 검증이다.

다음 동작은 이 Spec 구현의 기본 범위에 포함하지 않는다.

- AWS resource create/update/delete
- `terraform apply` 또는 `terraform destroy`
- ECR login/push
- ECS service update/force deployment
- secret value 생성·갱신
- SQLite data upload/migration

이 동작들은 생성된 runbook과 guarded script로만 제공하고, 사용자가 별도로 실행을 승인해야 한다.

## Tasks

- [ ] 1. 별도 IaC 저장소 scaffold 구성
  - [ ] 1.1 `toss-portfolio-lens-aws` root에 설계 문서의 Terraform·scripts·envs·tests 구조를 만든다.
  - [ ] 1.2 `.gitignore`에 backend HCL, real tfvars, `.terraform`, state, plan, `.artifacts`, release manifest, secret temp, SQLite를 추가한다.
  - [ ] 1.3 `.terraform.lock.hcl`은 provider 초기화 후 추적하되 credential과 state는 추적하지 않는 정책을 문서화한다.
  - [ ] 1.4 README 상단에 “애플리케이션과 별도 저장소”와 “기본적으로 배포하지 않음” 경계를 명시한다.
  - _Requirements: 1.1–1.6, 16.1, 16.7_

- [ ] 2. Terraform versions, provider, locals, variables 정의
  - [ ] 2.1 Terraform 1.10+와 구현 시점 안정 AWS provider constraint, partial S3 backend를 정의한다.
  - [ ] 2.2 `expected_account_id`와 `data.aws_caller_identity` precondition으로 account mismatch를 plan에서 거부한다.
  - [ ] 2.3 region 기본 `ap-northeast-2`, project/environment/owner, common tags와 naming locals를 구현한다.
  - [ ] 2.4 network, ECS, RDS, domain, S3, alarm, protection 변수를 type/description/validation과 함께 정의한다.
  - [ ] 2.5 Fargate 공식 CPU/memory allowlist와 `enable_service`/digest, domain/zone pair validation을 구현한다.
  - [ ] 2.6 secret 성격의 입력에는 `sensitive=true`를 쓰되 실제 app/db password 변수 자체는 만들지 않는다.
  - _Requirements: 2.3, 7.2–7.4, 8.3–8.5, 15.1, 16.1, 16.2_

- [ ] 3. 공통 안전 shell library와 preflight 구현
  - [ ] 3.1 `set -Eeuo pipefail` 공통 library에 command/version check, account/region assertion, exact confirmation, cleanup을 구현한다.
  - [ ] 3.2 AWS CLI v2, Terraform, Docker buildx, jq와 optional shellcheck/checkov 점검을 구현한다.
  - [ ] 3.3 `aws sts get-caller-identity` 결과를 expected account와 비교하고 region을 고정한다.
  - [ ] 3.4 서울 AZ 수와 RDS MySQL `db.t4g.small` orderable option read-only check를 구현한다.
  - [ ] 3.5 Docker daemon, app source path, Dockerfile, linux/amd64 지원과 위험 path를 점검한다.
  - [ ] 3.6 preflight가 secret이나 credential environment 값을 출력하지 않는지 shell test를 작성한다.
  - _Requirements: 2.1–2.6, 1.5, 12.7_

- [ ] 4. S3 remote state bootstrap script 구현
  - [ ] 4.1 globally unique state bucket name과 existing ownership 검증을 구현한다.
  - [ ] 4.2 exact confirmation 뒤에만 AWS CLI create를 수행하는 `--execute` guard를 구현한다.
  - [ ] 4.3 public block 4개, SSE-S3, versioning, insecure transport deny를 idempotent하게 구성한다.
  - [ ] 4.4 `use_lockfile=true` partial backend HCL을 `.artifacts` 또는 gitignored env file에 생성한다.
  - [ ] 4.5 dry/default mode에서는 예정 명령과 검증만 출력하고 mutation을 실행하지 않게 테스트한다.
  - _Requirements: 3.1–3.6, 1.4, 1.5_

- [ ] 5. VPC, subnet, routing과 security group 구현
  - [ ] 5.1 VPC, IGW, 2개 public subnet, 2개 private DB subnet과 AZ 선택을 구현한다.
  - [ ] 5.2 public default route와 association, local-only private route association을 구현한다.
  - [ ] 5.3 NAT Gateway/NAT instance resource를 만들지 않는다.
  - [ ] 5.4 ALB→ECS:3200, ECS→RDS:3306, ECS outbound HTTPS/DNS, public ALB 80/443 security group rule을 분리 resource로 구현한다.
  - [ ] 5.5 RDS와 ECS에 public CIDR direct inbound가 없는지 Terraform test를 작성한다.
  - [ ] 5.6 CIDR list length/overlap과 AZ validation을 구현한다.
  - _Requirements: 4.1–4.9, 15.2, 16.6_

- [ ] 6. ECR repository와 lifecycle 구현
  - [ ] 6.1 private ECR, immutable tag, scan on push, AES256 encryption을 구현한다.
  - [ ] 6.2 untagged cleanup과 최근 release 10개 보존 lifecycle policy를 구현한다.
  - [ ] 6.3 ECR이 `enable_service=false`에서도 생성되게 한다.
  - [ ] 6.4 repository URL, ARN, name output을 추가한다.
  - [ ] 6.5 tag immutability와 lifecycle JSON unit/assertion test를 작성한다.
  - _Requirements: 5.1, 5.2, 5.7, 13.2, 16.8_

- [ ] 7. private S3 report bucket 구현
  - [ ] 7.1 account ID와 region 기반 globally unique bucket name을 구현한다.
  - [ ] 7.2 public access block 4개, BucketOwnerEnforced, SSE-S3, versioning policy를 구현한다.
  - [ ] 7.3 insecure transport deny와 no-public-principal bucket policy를 구현한다.
  - [ ] 7.4 incomplete multipart cleanup, report expiration off, `force_destroy=false`를 구현한다.
  - [ ] 7.5 bucket name/ARN/prefix output과 public block Terraform test를 작성한다.
  - _Requirements: 9.1–9.8, 15.2, 16.6_

- [ ] 8. 최소 비용 RDS MySQL 구현
  - [ ] 8.1 두 private subnet의 DB subnet group과 ECS source-only DB security rule을 연결한다.
  - [ ] 8.2 `db.t4g.small`, Single-AZ, 20/50 GiB gp3, encrypted, public false를 구현한다.
  - [ ] 8.3 RDS managed master password와 Secrets Manager integration을 구현한다.
  - [ ] 8.4 backup 1일, windows, copy tags, deletion/final snapshot protection을 구현한다.
  - [ ] 8.5 Performance Insights, Enhanced Monitoring, Multi-AZ, log export가 기본 off인지 test한다.
  - [ ] 8.6 MySQL `require_secure_transport` parameter와 app CA contract를 변수/문서로 연결한다.
  - [ ] 8.7 endpoint/port/db name/user만 non-sensitive output으로 내보낸다.
  - _Requirements: 6.1–6.10, 15.2, 15.3, 16.6_

- [ ] 9. app secret container와 IAM role 분리 구현
  - [ ] 9.1 app Secrets Manager secret metadata만 만들고 secret version resource를 만들지 않는다.
  - [ ] 9.2 ECS execution role과 task role을 서로 다른 trust role로 만든다.
  - [ ] 9.3 execution role에 ECR/log managed policy와 exact app/RDS secret read만 추가한다.
  - [ ] 9.4 task role에 report prefix S3 get/put와 제한된 bucket metadata만 추가한다.
  - [ ] 9.5 task role에 Secrets/ECR/ECS/IAM 권한이 없고 execution role에 report object access가 없는지 test한다.
  - [ ] 9.6 app secret name/ARN만 output하고 값은 어떤 output에도 넣지 않는다.
  - _Requirements: 10.1, 10.5, 10.6, 10.9, 11.1–11.6, 16.6_

- [ ] 10. CloudWatch log group과 선택 alarm 구현
  - [ ] 10.1 `/ecs/<project>/<environment>` log group, 7일 기본 retention과 tags를 구현한다.
  - [ ] 10.2 ALB unhealthy host와 ECS task 부족에 대한 opt-in alarm을 구현한다.
  - [ ] 10.3 SNS destination이 없으면 alarm action을 만들지 않도록 validation한다.
  - [ ] 10.4 불필요한 verbose service log, ALB access log, custom KMS를 기본 생성하지 않는다.
  - _Requirements: 12.1, 12.2, 12.6, 15.2, 15.6_

- [ ] 11. ALB와 target group 구현
  - [ ] 11.1 public subnet 2개의 internet-facing ALB를 구현한다.
  - [ ] 11.2 IP target group, port 3200, `/api/health`, matcher 200과 deregistration 설정을 구현한다.
  - [ ] 11.3 domain 없는 경우 HTTP listener와 명시적 production warning output을 구현한다.
  - [ ] 11.4 deletion protection/access log를 비용·운영 변수로 두고 기본값을 문서와 일치시킨다.
  - [ ] 11.5 ALB SG 이외의 source가 target port에 접근하지 않는지 test한다.
  - _Requirements: 8.1, 8.2, 8.5, 8.7, 15.2_

- [ ] 12. 선택적 ACM과 Route 53 구성 구현
  - [ ] 12.1 domain+zone이 함께 있을 때만 ACM certificate와 DNS validation을 만든다.
  - [ ] 12.2 HTTPS listener와 구현 시점 권장 TLS policy를 적용한다.
  - [ ] 12.3 HTTP→HTTPS 301 redirect와 Route 53 ALB alias를 구현한다.
  - [ ] 12.4 domain 유무에 따라 `PUBLIC_APP_URL`을 결정하는 local과 output을 구현한다.
  - [ ] 12.5 zone 자체는 생성하지 않고 pair validation test를 작성한다.
  - _Requirements: 8.3–8.7_

- [ ] 13. ECS task definition 구현
  - [ ] 13.1 Fargate/awsvpc/Linux/X86_64, task CPU/memory, execution/task role을 구성한다.
  - [ ] 13.2 pinned ECR digest, port 3200, non-root image contract, awslogs를 구성한다.
  - [ ] 13.3 production/host/port/public URL, RDS, required MySQL TLS, report S3 환경 변수를 구성한다.
  - [ ] 13.4 app secret과 RDS password를 JSON key별 ECS `secrets`로 주입한다.
  - [ ] 13.5 static AWS access key, local report persistence, SQLite fallback 설정이 container definition에 없는지 test한다.
  - [ ] 13.6 `enable_service=false` 또는 digest null일 때 task definition을 만들지 않게 한다.
  - [ ] 13.7 2048 CPU/2048 memory가 validation 실패하고 2048/4096이 성공하는 test를 작성한다.
  - _Requirements: 7.1–7.10, 9.5, 10.6, 11.1–11.5, 16.6_

- [ ] 14. ECS service와 배포 안전 설정 구현
  - [ ] 14.1 public subnet 2개, public IP, ECS SG, ALB target group의 Fargate service를 구현한다.
  - [ ] 14.2 desired count 1, circuit breaker rollback, health grace, deployment healthy percent를 구현한다.
  - [ ] 14.3 기본 FARGATE와 opt-in FARGATE_SPOT capacity provider strategy를 구현한다.
  - [ ] 14.4 autoscaling은 off가 기본이고 opt-in일 때만 target/capacity를 만든다.
  - [ ] 14.5 digest가 같으면 불필요한 task definition 변경이 없는지 stable JSON ordering을 확인한다.
  - _Requirements: 7.1, 7.4, 7.6, 7.10, 12.3, 13.7, 15.3, 15.7_

- [ ] 15. app secret 입력 script 구현
  - [ ] 15.1 required/optional JSON key를 interactive prompt로 받고 필수값 empty와 `SESSION_SECRET` 32자 하한을 검증하되 `DASHBOARD_PASSWORD` 최소 길이는 강제하지 않는다.
  - [ ] 15.2 `umask 077`, mode 600 temp file, trap cleanup과 AWS CLI file input을 사용한다.
  - [ ] 15.3 secret JSON, 입력값, CLI response payload를 stdout/stderr에 출력하지 않는다.
  - [ ] 15.4 기본 mode는 secret metadata/key 존재 여부만 read-only 검증하고 `--execute`+confirmation일 때만 put한다.
  - [ ] 15.5 rotation 뒤 ECS 새 배포가 필요하다는 명확한 next step을 출력한다.
  - [ ] 15.6 mocked AWS CLI로 temp cleanup, no-output, missing-key, confirmation test를 작성한다.
  - _Requirements: 10.2–10.4, 10.7, 10.8, 1.5, 12.7_

- [ ] 16. 로컬 image build·ECR push script 구현
  - [ ] 16.1 `APP_SOURCE_DIR`, clean Git state, Dockerfile, `.dockerignore`, platform을 검증한다.
  - [ ] 16.2 source commit+UTC 기반 immutable tag와 dirty override suffix를 구현한다.
  - [ ] 16.3 default mode에서는 build 계획만 보여 주고 `--execute`에서 linux/amd64 build를 실행한다.
  - [ ] 16.4 exact account/region ECR login을 password-stdin으로 수행한다.
  - [ ] 16.5 push 후 ECR digest를 조회·형식 검증하고 gitignored release manifest를 원자적으로 쓴다.
  - [ ] 16.6 image history/context에 `.env`, DB, reports, secret이 없는지 점검 명령을 포함한다.
  - [ ] 16.7 mock command test로 tag/digest/account mismatch와 failed build/push를 검증한다.
  - _Requirements: 5.3–5.8, 13.3, 1.4, 2.6_

- [ ] 17. plan과 guarded deploy workflow 구현
  - [ ] 17.1 backend init, workspace/environment assertion과 foundation `enable_service=false` plan mode를 구현한다.
  - [ ] 17.2 service plan 전에 app secret key presence와 ECR digest 존재를 read-only 검증한다.
  - [ ] 17.3 plan을 `.artifacts` binary file로 저장하고 human-readable redacted summary를 만든다.
  - [ ] 17.4 deploy script는 saved plan, creation time, account/region, exact confirmation과 `--execute`가 모두 맞을 때만 apply한다.
  - [ ] 17.5 foundation→secret→build/push→service의 2단계 상태를 명확히 안내한다.
  - [ ] 17.6 `terraform destroy`를 일반 workflow에서 제외하고 data-safe break-glass 문서로 분리한다.
  - [ ] 17.7 기본 invocation에서 AWS/Terraform mutation command가 실행되지 않는 test를 작성한다.
  - _Requirements: 1.3–1.5, 13.1–13.8, 10.7_

- [ ] 18. 배포 후 verify와 rollback script 구현
  - [ ] 18.1 ECS service stable wait와 desired/running/pending count 검증을 구현한다.
  - [ ] 18.2 target health, application URL, HTTPS redirect와 `/api/health` status를 검증한다.
  - [ ] 18.3 health JSON이 `storage=mysql`, `reportStorage=s3`인지 확인한다.
  - [ ] 18.4 RDS public false, report S3 public block true, task image digest 일치를 AWS CLI read-only로 재검증한다.
  - [ ] 18.5 rollback이 last-known-good manifest/digest를 검증하고 Terraform plan/apply workflow를 재사용하게 한다.
  - [ ] 18.6 rollback도 `--execute`와 exact confirmation 없이는 plan만 생성하게 한다.
  - _Requirements: 12.4, 12.5, 13.5–13.8, 7.9_

- [ ] 19. optional SQLite migration runbook 작성
  - [ ] 19.1 기본 AWS 배포가 빈 RDS이며 자동 data transfer가 없음을 명시한다.
  - [ ] 19.2 pause/copy/checksum/private migration prefix/one-off task/row validation/cleanup 절차를 작성한다.
  - [ ] 19.3 app image에 필요한 one-off migration command 또는 sidecar contract를 명시한다.
  - [ ] 19.4 migration 전 RDS snapshot과 실패 rollback 절차를 작성한다.
  - [ ] 19.5 SQLite가 image/state/report prefix에 들어가지 않는 체크리스트를 작성한다.
  - [ ] 19.6 이 문서만 만들고 migration code 실행·upload·task run은 하지 않는다.
  - _Requirements: 14.1–14.6_

- [ ] 20. outputs, examples와 전체 운영 README 완성
  - [ ] 20.1 non-sensitive Terraform output과 `terraform output -json` 소비 방법을 구현한다.
  - [ ] 20.2 production backend/tfvars example에 서울 리전, 1/2 Fargate, db.t4g.small, desired 1 기본값을 넣는다.
  - [ ] 20.3 example에 실제 계정 ID, ARN, domain, password, key를 넣지 않는다.
  - [ ] 20.4 README에 prerequisites부터 bootstrap, foundation, secret, build, service, verify, release, rotation, rollback 순서를 작성한다.
  - [ ] 20.5 ALB/RDS 고정 비용, no-NAT trade-off, 2 vCPU/2 GiB Fargate 불가, scale-up 2/4를 명시한다.
  - [ ] 20.6 backup/restore, safe teardown, troubleshooting, Pricing Calculator/Budget 점검을 작성한다.
  - [ ] 20.7 각 mutation step에 영향·성공 기준·rollback을 붙인다.
  - _Requirements: 2.1–2.6, 13.8, 15.1–15.7, 16.8_

- [ ] 21. 정적 검증과 최종 인수 확인
  - [ ] 21.1 `terraform fmt -check -recursive`를 통과시킨다.
  - [ ] 21.2 `terraform init -backend=false`와 `terraform validate`를 통과시킨다.
  - [ ] 21.3 `terraform test`로 network/RDS/S3/IAM/Fargate validation을 통과시킨다.
  - [ ] 21.4 `shellcheck scripts/*.sh`와 script mock tests를 통과시킨다.
  - [ ] 21.5 optional Checkov/tfsec 결과의 high finding을 해결하거나 documented exception으로 남긴다.
  - [ ] 21.6 `rg` 기반 secret pattern 검사로 Markdown/example/code에 실제 credential이 없음을 확인한다.
  - [ ] 21.7 `terraform providers schema`/static graph로 요구 리소스는 있고 NAT, public RDS, public S3는 없음을 검토한다.
  - [ ] 21.8 최종 인수 과정에서도 AWS mutation, Docker push, Terraform apply를 실행하지 않는다.
  - _Requirements: 1.3, 1.4, 16.1–16.8_
