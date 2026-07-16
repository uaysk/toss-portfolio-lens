# Toss Portfolio Lens · Kiro Spec Workspace

이 압축 묶음은 빈 디렉터리에 풀고 그 디렉터리를 AWS Kiro에서 열면 바로 사용할 수 있는 Spec 워크스페이스입니다. 실제 애플리케이션 코드나 Terraform 코드는 포함하지 않으며, Kiro가 이를 다시 구현하도록 하는 Markdown 설계 자료만 포함합니다.

## 포함된 Spec

| Spec | 목적 | 생성 대상 |
| --- | --- | --- |
| `toss-portfolio-lens-rebuild` | 지금까지 확정된 Portfolio Lens 기능 전체를 새로 구현 | 애플리케이션 저장소 |
| `aws-seoul-deployment` | 애플리케이션과 분리된 AWS CLI + Terraform 배포 저장소를 구현 | 별도 IaC 저장소 |

두 Spec은 독립적으로 실행할 수 있습니다. 애플리케이션을 먼저 구현한 뒤 배포 Spec을 실행하는 순서를 권장하지만, 기존 호환 Docker 이미지가 있다면 배포 Spec만 실행해도 됩니다.

## 사용 방법

1. `kiro.zip`을 새 디렉터리에 압축 해제합니다.
2. 압축을 푼 디렉터리 자체를 Kiro IDE의 워크스페이스 루트로 엽니다.
3. Kiro의 Specs 패널에서 원하는 Spec을 엽니다.
4. `requirements.md`, `design.md`, `tasks.md`를 검토하고 승인한 뒤 작업을 시작합니다.
5. Kiro CLI v3를 사용한다면 `/spec`, `/spec toss-portfolio-lens-rebuild`, `/spec aws-seoul-deployment`로 확인하고 `/spec run <name>`으로 미완료 작업을 진행할 수 있습니다.

Kiro가 인식하는 핵심 경로는 다음과 같습니다.

```text
.
├── AGENTS.md
├── README.md
└── .kiro
    ├── steering
    │   ├── product.md
    │   ├── security-and-data.md
    │   ├── structure.md
    │   └── tech.md
    └── specs
        ├── aws-seoul-deployment
        │   ├── design.md
        │   ├── requirements.md
        │   └── tasks.md
        └── toss-portfolio-lens-rebuild
            ├── design.md
            ├── requirements.md
            └── tasks.md
```

## 중요한 실행 경계

- 이 문서 묶음을 만드는 단계에서는 AWS 리소스를 생성하거나 변경하지 않습니다.
- 배포 Spec을 구현하는 단계도 기본적으로 Terraform 코드와 운영 스크립트를 생성하고 정적 검증하는 데까지만 진행합니다.
- `terraform apply`, `terraform destroy`, ECR 이미지 push, ECS 서비스 변경은 사용자가 별도로 실행을 지시한 경우에만 수행합니다.
- 비밀번호, 토스증권 자격증명, OpenAI 키, AWS 장기 액세스 키를 코드, `tfvars`, Terraform state, 로그에 넣지 않습니다.
- 토스증권 연동은 조회 전용입니다. 주문 생성·정정·취소, 매수 가능 금액, 매도 가능 수량 등 거래 동작은 구현하지 않습니다.

## 용량 선택의 근거

- RDS 기본 인스턴스는 `db.t4g.small`로 설계합니다. 이 인스턴스는 2 vCPU와 2 GiB 메모리입니다.
- ECS는 운영 부담을 낮추기 위해 Fargate를 사용합니다. Fargate에는 2 vCPU/2 GiB 조합이 없으므로 비용 최소 기본값을 1 vCPU/2 GiB(`cpu=1024`, `memory=2048`)로 둡니다.
- CPU 2 vCPU가 실제로 필요하면 변수만 바꿔 2 vCPU/4 GiB(`cpu=2048`, `memory=4096`)로 올립니다.
- NAT Gateway는 만들지 않고, ALB는 퍼블릭 서브넷에, 단일 ECS 태스크는 퍼블릭 IP를 가진 퍼블릭 서브넷에, RDS는 인터넷 경로가 없는 프라이빗 서브넷에 둡니다. ECS 보안 그룹은 ALB에서 오는 3200 포트만 인바운드로 허용합니다.

## 공식 문서 기준

- [Kiro Specs](https://kiro.dev/docs/cli/v3/specs/)
- [Kiro Steering](https://kiro.dev/docs/steering/)
- [ECS Fargate CPU/메모리 조합](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-cpu-memory-error.html)
- [RDS 인스턴스 하드웨어 사양](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Summary.html)
- [ECR 로컬 이미지 push](https://docs.aws.amazon.com/AmazonECR/latest/userguide/getting-started-cli.html)
- [ECS Secrets Manager 환경 변수](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)
- [Terraform S3 backend 및 lockfile](https://developer.hashicorp.com/terraform/language/backend/s3)
