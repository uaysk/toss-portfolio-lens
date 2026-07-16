# AWS EKS deployment

이 디렉터리는 `toss-portfolio-lens`를 AWS에 반복 배포하기 위한 실행 자산입니다. 애플리케이션 코드는 서울 리전의 EKS에서 실행하고, 보고서 JSON은 S3, 관계형 데이터는 비공개 RDS MariaDB에 저장합니다. AI 평가는 스톡홀름 리전의 Amazon Bedrock Kimi K2.5를 호출합니다.

배포된 애플리케이션의 토스증권 업스트림은 항상 `https://tpl.uaysk.com/`입니다. 인증에는 로컬 `.env`의 `DASHBOARD_PASSWORD`를 정적 Bearer 토큰으로 사용하며 토큰 값은 CloudFormation, 이미지, Git 또는 명령 출력에 기록하지 않습니다.

## 생성되는 구성

| 계층 | 리소스 | 기본값 |
| --- | --- | --- |
| 네트워크 | 전용 VPC, 인터넷 공개 서브넷 2개, 격리 DB 서브넷 2개 | `10.42.0.0/16`, 서울 리전 2개 AZ |
| 컴퓨팅 | 표준 EKS, 관리형 노드 그룹 1대 | `t3.small`, AL2023, 20 GiB gp3 |
| 공개 진입점 | AWS Load Balancer Controller가 관리하는 인터넷 공개 NLB | HTTP 80 → Pod 3200 |
| 데이터베이스 | RDS MariaDB, 관리형 마스터 비밀번호 | 11.8.8, `db.t4g.small`, 20 GiB gp3, Single-AZ |
| 보고서 | 비공개 S3 버킷 | 버전 관리, SSE-S3, `portfolio-reports/` |
| 이미지 | ECR | immutable tag, push scan, 최근 20개 유지 |
| AI | Amazon Bedrock | `eu-north-1`, `moonshotai.kimi-k2.5` |
| AWS 권한 | EKS Pod Identity | 앱은 지정 S3 prefix와 Kimi 모델만 접근 |

비용을 줄이기 위해 NAT Gateway를 만들지 않고 단일 노드를 공개 서브넷에 둡니다. 노드에는 SSH 키나 공개 인바운드 규칙이 없고, IMDSv2를 강제하며 Pod에서 노드 역할을 사용할 수 없도록 hop limit을 1로 설정합니다. RDS 서브넷에는 인터넷 경로가 없고 MariaDB 3306은 EKS 노드 보안 그룹에서만 허용합니다.

## 사전 조건

- AWS CLI v2 자격 증명과 CloudFormation, EKS, EC2, IAM, ECR, RDS, Secrets Manager, S3, Bedrock, ELB 리소스를 만들 권한
- Docker, kubectl, Helm, jq, curl, Git
- 프로젝트 루트의 `.env`에 비어 있지 않은 `DASHBOARD_PASSWORD`와 32자 이상 `SESSION_SECRET`
- 이 계정에서 Bedrock Kimi K2.5 약관/모델 접근이 활성화된 상태
- Docker 빌드 및 Helm/ECR/공개 이미지 레지스트리에 접근 가능한 네트워크

`.env`는 `source`하지 않고 단순 `KEY=value` 형식으로 읽습니다. 따옴표로 감싼 한 줄 값은 지원하지만 여러 줄 값과 셸 확장은 지원하지 않습니다.

## 배포

프로젝트 루트에서 실행합니다.

```bash
./infra/aws/deploy.sh
```

스크립트는 다음 작업을 멱등적으로 수행합니다.

1. CloudFormation 템플릿과 서울 RDS/스톡홀름 Bedrock 가용성을 읽기 전용으로 점검합니다.
2. VPC, EKS/ECR, RDS, S3, IAM 리소스를 생성 또는 갱신합니다.
3. EKS Pod Identity와 AWS Load Balancer Controller Helm chart를 설정합니다.
4. RDS 관리형 비밀번호를 Secrets Manager에서 읽되 출력하지 않고 Kubernetes Secret으로 전달합니다.
5. 로컬 Docker 이미지를 `linux/amd64`로 빌드해 ECR에 푸시합니다.
6. Deployment와 NLB Service를 적용하고 NLB 주소로 `api/health`를 검증합니다.
7. 상태 응답이 `mysql`, `s3`, AI 보고서 `configured`를 모두 나타낼 때만 성공으로 종료합니다.

자주 사용하는 선택적 재정의 값은 다음과 같습니다.

```bash
IMAGE_TAG=release-2026-07-16 \
CLUSTER_PUBLIC_ACCESS_CIDR=203.0.113.10/32 \
./infra/aws/deploy.sh
```

| 변수 | 기본값/동작 |
| --- | --- |
| `AWS_REGION` | `ap-northeast-2`만 허용 |
| `BEDROCK_REGION` | `eu-north-1`만 허용 |
| `BEDROCK_MODEL_ID` | `moonshotai.kimi-k2.5`만 허용 |
| `CLUSTER_PUBLIC_ACCESS_CIDR` | 미지정 시 현재 공인 IPv4 `/32` 자동 감지 |
| `KUBERNETES_VERSION` | 미지정 시 EKS의 현재 기본 버전 |
| `IMAGE_TAG` | Git SHA; tracked 파일이 dirty면 UTC 시각 suffix 추가 |
| `PUBLIC_APP_URL` | 미지정 시 `http://<NLB DNS>` |
| `ENV_FILE` | 프로젝트 루트 `.env` |

## 보안과 운영상 주의점

- Kubernetes Secret에는 대시보드 비밀번호, 세션 비밀, 업스트림 Bearer 토큰, RDS 자격 증명만 저장합니다. Git에 생성형 Secret manifest를 남기지 않습니다.
- RDS는 `require_secure_transport=1`이고 클라이언트도 TLS를 사용합니다. 배포 스크립트가 AWS 공식 global RDS CA bundle을 받아 ConfigMap으로 마운트하고 `MYSQL_SSL_REJECT_UNAUTHORIZED=true`로 서버 인증서 체인을 검증합니다.
- 기본 NLB 주소는 HTTP라 브라우저와 NLB 사이의 로그인 비밀번호가 암호화되지 않습니다. 실제 사용자 로그인 전 ACM 인증서와 소유한 도메인으로 TLS listener를 구성하고 `PUBLIC_APP_URL=https://...`를 지정해야 합니다.
- EKS API의 공개 접근은 배포 시점 공인 IPv4 `/32`로 제한됩니다. 운영자 IP가 바뀌면 `CLUSTER_PUBLIC_ACCESS_CIDR`을 새 값으로 지정해 스택을 다시 갱신합니다. 노드는 private EKS endpoint를 사용합니다.
- S3와 ECR은 CloudFormation 스택 삭제 시 보존하고 RDS는 최종 스냅샷을 생성하도록 설정했습니다. 데이터가 있는 ECR/S3를 실수로 삭제하지 않기 위한 선택입니다.
- 단일 EKS 노드와 Single-AZ RDS는 비용 절감 구성이며 고가용성이 아닙니다. 장애 허용이 필요하면 노드와 RDS Multi-AZ를 늘려야 합니다.

## 상태 확인

```bash
kubectl --context toss-portfolio-lens -n portfolio-lens get deploy,pod,svc
kubectl --context toss-portfolio-lens -n portfolio-lens rollout status deploy/portfolio-lens
curl "http://$(kubectl --context toss-portfolio-lens -n portfolio-lens get svc portfolio-lens -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')/api/health"
```

정상 상태 응답은 저장소가 `mysql`, 보고서 저장소가 `s3`, 보고서 생성이 `configured`여야 합니다.

## 정리와 롤백

CloudFormation 삭제 전에 Kubernetes Service와 Controller를 지워 LBC가 만든 NLB, target group, 보안 그룹을 먼저 정리합니다. Pod Identity association도 스택 외부의 EKS API 리소스이므로 함께 제거해야 합니다.

```bash
kubectl --context toss-portfolio-lens -n portfolio-lens delete service portfolio-lens
helm --kube-context toss-portfolio-lens -n kube-system uninstall aws-load-balancer-controller
aws eks list-pod-identity-associations --region ap-northeast-2 --cluster-name toss-portfolio-lens
```

그 뒤 association을 `aws eks delete-pod-identity-association`으로 삭제하고 CloudFormation 스택을 삭제합니다. 보존된 S3 버킷/ECR 저장소와 RDS 최종 스냅샷은 필요 여부를 확인한 후 별도로 정리합니다. 리소스 삭제는 비용과 데이터에 영향을 주므로 이 문서의 자동 스크립트에는 포함하지 않았습니다.

## 파일

- `cloudformation.yaml`: AWS 리소스와 IAM 권한
- `k8s/app.yaml`: hardened 단일 replica Deployment와 NLB Service
- `deploy.sh`: 검사, 프로비저닝, 빌드/푸시, 배포, 검증 오케스트레이션

AWS Load Balancer Controller chart는 AWS 공식 설치 문서의 현재 조합인 controller v2.14.1 / chart 1.14.0 정책을 기준으로 고정했습니다. 보안 업데이트 시 `LBC_CHART_VERSION`과 템플릿의 공식 IAM 정책을 함께 갱신해야 합니다.
