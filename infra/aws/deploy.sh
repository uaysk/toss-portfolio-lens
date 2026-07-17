#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
TEMPLATE_FILE="${SCRIPT_DIR}/cloudformation.yaml"
APP_MANIFEST="${SCRIPT_DIR}/k8s/app.yaml"

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
BEDROCK_REGION="${BEDROCK_REGION:-eu-north-1}"
BEDROCK_MODEL_ID="${BEDROCK_MODEL_ID:-moonshotai.kimi-k2.5}"
STACK_NAME="${STACK_NAME:-toss-portfolio-lens}"
CLUSTER_NAME="${CLUSTER_NAME:-toss-portfolio-lens}"
ECR_REPOSITORY="${ECR_REPOSITORY:-toss-portfolio-lens}"
KUBERNETES_VERSION="${KUBERNETES_VERSION:-}"
RDS_ENGINE_VERSION="${RDS_ENGINE_VERSION:-11.8.8}"
RDS_INSTANCE_CLASS="${RDS_INSTANCE_CLASS:-db.t4g.small}"
NODE_INSTANCE_TYPE="${NODE_INSTANCE_TYPE:-t3.small}"
REPORT_PREFIX="${REPORT_PREFIX:-portfolio-reports}"
LBC_CHART_VERSION="${LBC_CHART_VERSION:-1.14.0}"
ENV_FILE="${ENV_FILE:-${PROJECT_ROOT}/.env}"
NAMESPACE="portfolio-lens"

log() {
  printf '[aws-deploy] %s\n' "$*"
}

fail() {
  printf '[aws-deploy] 오류: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 명령을 찾을 수 없습니다."
}

env_value() {
  local key="$1"
  local value
  value="$(awk -v key="${key}" '
    index($0, key "=") == 1 { value = substr($0, length(key) + 2) }
    END { printf "%s", value }
  ' "${ENV_FILE}")"
  value="${value%$'\r'}"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "${value}"
}

stack_output() {
  local key="$1"
  local value
  value="$(aws cloudformation describe-stacks \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]" \
    --output text)"
  [[ -n "${value}" && "${value}" != "None" ]] || fail "CloudFormation 출력 ${key}를 찾지 못했습니다."
  printf '%s' "${value}"
}

ensure_pod_identity_association() {
  local namespace="$1"
  local service_account="$2"
  local role_arn="$3"
  local association_id
  association_id="$(aws eks list-pod-identity-associations \
    --region "${AWS_REGION}" \
    --cluster-name "${CLUSTER_NAME}" \
    --namespace "${namespace}" \
    --service-account "${service_account}" \
    --query 'associations[0].associationId' \
    --output text)"

  if [[ -z "${association_id}" || "${association_id}" == "None" ]]; then
    aws eks create-pod-identity-association \
      --region "${AWS_REGION}" \
      --cluster-name "${CLUSTER_NAME}" \
      --namespace "${namespace}" \
      --service-account "${service_account}" \
      --role-arn "${role_arn}" \
      --tags Project=toss-portfolio-lens >/dev/null
  else
    aws eks update-pod-identity-association \
      --region "${AWS_REGION}" \
      --cluster-name "${CLUSTER_NAME}" \
      --association-id "${association_id}" \
      --role-arn "${role_arn}" >/dev/null
  fi
}

for command_name in aws docker kubectl helm jq curl git grep sed awk tr seq; do
  require_command "${command_name}"
done

[[ -f "${ENV_FILE}" ]] || fail "환경 파일을 찾을 수 없습니다: ${ENV_FILE}"
[[ "${AWS_REGION}" == "ap-northeast-2" ]] || fail "인프라 리전은 ap-northeast-2(서울)만 허용합니다."
[[ "${BEDROCK_REGION}" == "eu-north-1" ]] || fail "Bedrock 리전은 eu-north-1(스톡홀름)이어야 합니다."
[[ "${BEDROCK_MODEL_ID}" == "moonshotai.kimi-k2.5" ]] || fail "Bedrock 모델은 moonshotai.kimi-k2.5여야 합니다."

if [[ -z "${CLUSTER_PUBLIC_ACCESS_CIDR:-}" ]]; then
  DEPLOYER_PUBLIC_IP="$(curl --fail --silent --show-error --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
  [[ "${DEPLOYER_PUBLIC_IP}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail "배포자 공인 IPv4 주소를 확인하지 못했습니다. CLUSTER_PUBLIC_ACCESS_CIDR을 직접 지정하세요."
  CLUSTER_PUBLIC_ACCESS_CIDR="${DEPLOYER_PUBLIC_IP}/32"
fi
[[ "${CLUSTER_PUBLIC_ACCESS_CIDR}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]] || fail "CLUSTER_PUBLIC_ACCESS_CIDR 형식이 올바르지 않습니다."

DASHBOARD_PASSWORD="$(env_value DASHBOARD_PASSWORD)"
SESSION_SECRET="$(env_value SESSION_SECRET)"
[[ -n "${DASHBOARD_PASSWORD}" ]] || fail ".env의 DASHBOARD_PASSWORD가 비어 있습니다."
[[ ${#SESSION_SECRET} -ge 32 ]] || fail ".env의 SESSION_SECRET은 32자 이상이어야 합니다."
[[ "${DASHBOARD_PASSWORD}" != *$'\n'* && "${DASHBOARD_PASSWORD}" != *$'\r'* ]] || fail "DASHBOARD_PASSWORD에는 줄바꿈을 사용할 수 없습니다."
[[ "${SESSION_SECRET}" != *$'\n'* && "${SESSION_SECRET}" != *$'\r'* ]] || fail "SESSION_SECRET에는 줄바꿈을 사용할 수 없습니다."

TMP_DIR="$(mktemp -d)"
ECR_REGISTRY=""
cleanup() {
  unset DASHBOARD_PASSWORD SESSION_SECRET MYSQL_PASSWORD DB_SECRET_JSON
  if [[ -n "${ECR_REGISTRY}" ]]; then
    docker logout "${ECR_REGISTRY}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "${TMP_DIR}"
}
trap cleanup EXIT

log "AWS 자격 증명과 요청 리전의 서비스 가용성을 확인합니다."
aws sts get-caller-identity >/dev/null
aws cloudformation validate-template \
  --region "${AWS_REGION}" \
  --template-body "file://${TEMPLATE_FILE}" >/dev/null

RDS_OPTION_COUNT="$(aws rds describe-orderable-db-instance-options \
  --region "${AWS_REGION}" \
  --engine mariadb \
  --engine-version "${RDS_ENGINE_VERSION}" \
  --db-instance-class "${RDS_INSTANCE_CLASS}" \
  --query 'length(OrderableDBInstanceOptions)' \
  --output text)"
[[ "${RDS_OPTION_COUNT}" =~ ^[1-9][0-9]*$ ]] || fail "${AWS_REGION}에서 MariaDB ${RDS_ENGINE_VERSION} / ${RDS_INSTANCE_CLASS} 조합을 사용할 수 없습니다."

aws bedrock get-foundation-model \
  --region "${BEDROCK_REGION}" \
  --model-identifier "${BEDROCK_MODEL_ID}" >/dev/null || \
  fail "${BEDROCK_REGION}에서 ${BEDROCK_MODEL_ID} 모델을 조회할 수 없습니다. Bedrock 권한과 모델 접근 상태를 확인하세요."

log "CloudFormation 스택 ${STACK_NAME}을 생성 또는 갱신합니다."
PARAMETERS=(
  "ClusterName=${CLUSTER_NAME}"
  "ClusterPublicAccessCidr=${CLUSTER_PUBLIC_ACCESS_CIDR}"
  "RepositoryName=${ECR_REPOSITORY}"
  "NodeInstanceType=${NODE_INSTANCE_TYPE}"
  "DatabaseInstanceClass=${RDS_INSTANCE_CLASS}"
  "DatabaseEngineVersion=${RDS_ENGINE_VERSION}"
  "ReportPrefix=${REPORT_PREFIX}"
  "BedrockRegion=${BEDROCK_REGION}"
  "BedrockModelId=${BEDROCK_MODEL_ID}"
)
if [[ -n "${KUBERNETES_VERSION}" ]]; then
  PARAMETERS+=("KubernetesVersion=${KUBERNETES_VERSION}")
fi

aws cloudformation deploy \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE_FILE}" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${PARAMETERS[@]}" \
  --tags Project=toss-portfolio-lens ManagedBy=cloudformation

CLUSTER_NAME="$(stack_output ClusterName)"
VPC_ID="$(stack_output VpcId)"
REPOSITORY_URI="$(stack_output RepositoryUri)"
REPORT_BUCKET="$(stack_output ReportBucketName)"
REPORT_PREFIX="$(stack_output ReportPrefix)"
DATABASE_HOST="$(stack_output DatabaseEndpoint)"
DATABASE_PORT="$(stack_output DatabasePort)"
DATABASE_NAME="$(stack_output DatabaseName)"
DATABASE_SECRET_ARN="$(stack_output DatabaseSecretArn)"
APP_POD_ROLE_ARN="$(stack_output AppPodRoleArn)"
LBC_POD_ROLE_ARN="$(stack_output LoadBalancerControllerPodRoleArn)"

log "EKS kubeconfig을 갱신합니다."
aws eks update-kubeconfig \
  --region "${AWS_REGION}" \
  --name "${CLUSTER_NAME}" \
  --alias "${CLUSTER_NAME}" >/dev/null
kubectl config use-context "${CLUSTER_NAME}" >/dev/null
kubectl get nodes >/dev/null

kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl create serviceaccount portfolio-lens \
  --namespace "${NAMESPACE}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl create serviceaccount aws-load-balancer-controller \
  --namespace kube-system \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

log "AWS 공식 RDS CA 번들을 설치합니다."
RDS_CA_FILE="${TMP_DIR}/global-bundle.pem"
curl --fail --silent --show-error --max-time 30 \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  --output "${RDS_CA_FILE}"
grep -q -- "-----BEGIN CERTIFICATE-----" "${RDS_CA_FILE}" || fail "RDS CA 번들을 확인하지 못했습니다."
kubectl create configmap portfolio-lens-rds-ca \
  --namespace "${NAMESPACE}" \
  --from-file=global-bundle.pem="${RDS_CA_FILE}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

log "EKS Pod Identity 연결을 생성 또는 갱신합니다."
ensure_pod_identity_association "${NAMESPACE}" portfolio-lens "${APP_POD_ROLE_ARN}"
ensure_pod_identity_association kube-system aws-load-balancer-controller "${LBC_POD_ROLE_ARN}"

log "AWS Load Balancer Controller를 설치 또는 갱신합니다."
helm repo add eks https://aws.github.io/eks-charts --force-update >/dev/null
helm repo update eks >/dev/null
helm show crds eks/aws-load-balancer-controller \
  --version "${LBC_CHART_VERSION}" | kubectl apply -f - >/dev/null
helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  --namespace kube-system \
  --version "${LBC_CHART_VERSION}" \
  --set "clusterName=${CLUSTER_NAME}" \
  --set "region=${AWS_REGION}" \
  --set "vpcId=${VPC_ID}" \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set replicaCount=1 \
  --wait \
  --timeout 10m >/dev/null

log "RDS 관리형 마스터 시크릿을 안전하게 읽어 Kubernetes Secret으로 전달합니다."
DB_SECRET_JSON="$(aws secretsmanager get-secret-value \
  --region "${AWS_REGION}" \
  --secret-id "${DATABASE_SECRET_ARN}" \
  --query SecretString \
  --output text)"
MYSQL_USER="$(jq -er '.username' <<<"${DB_SECRET_JSON}")"
MYSQL_PASSWORD="$(jq -er '.password' <<<"${DB_SECRET_JSON}")"
unset DB_SECRET_JSON
[[ "${MYSQL_USER}" != *$'\n'* && "${MYSQL_PASSWORD}" != *$'\n'* ]] || fail "RDS 시크릿 값에는 줄바꿈을 사용할 수 없습니다."

SECRETS_ENV_FILE="${TMP_DIR}/app-secrets.env"
umask 077
{
  printf 'DASHBOARD_PASSWORD=%s\n' "${DASHBOARD_PASSWORD}"
  printf 'SESSION_SECRET=%s\n' "${SESSION_SECRET}"
  printf 'TOSS_API_BEARER_TOKEN=%s\n' "${DASHBOARD_PASSWORD}"
  printf 'MYSQL_USER=%s\n' "${MYSQL_USER}"
  printf 'MYSQL_PASSWORD=%s\n' "${MYSQL_PASSWORD}"
} >"${SECRETS_ENV_FILE}"

kubectl create secret generic portfolio-lens \
  --namespace "${NAMESPACE}" \
  --from-env-file="${SECRETS_ENV_FILE}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
rm -f -- "${SECRETS_ENV_FILE}"
unset MYSQL_PASSWORD

kubectl create configmap portfolio-lens \
  --namespace "${NAMESPACE}" \
  --from-literal=HOST=0.0.0.0 \
  --from-literal=PORT=3200 \
  --from-literal=NODE_ENV=production \
  --from-literal=DB_PROVIDER=mysql \
  --from-literal=DATABASE_PATH=/app/data/portfolio-history.sqlite \
  --from-literal=MYSQL_HOST="${DATABASE_HOST}" \
  --from-literal=MYSQL_PORT="${DATABASE_PORT}" \
  --from-literal=MYSQL_DATABASE="${DATABASE_NAME}" \
  --from-literal=MYSQL_CONNECT_TIMEOUT_MS=10000 \
  --from-literal=MYSQL_SSL=true \
  --from-literal=MYSQL_SSL_CA_PATH=/app/certs/global-bundle.pem \
  --from-literal=MYSQL_SSL_REJECT_UNAUTHORIZED=true \
  --from-literal=TOSS_API_AUTH_MODE=static_bearer \
  --from-literal=TOSS_API_BASE_URL=https://tpl.uaysk.com/ \
  --from-literal=SNAPSHOT_REFRESH_HOURS=6 \
  --from-literal=PUBLIC_APP_URL=http://pending.invalid \
  --from-literal=REPORT_AI_PROVIDER=bedrock \
  --from-literal=BEDROCK_REGION="${BEDROCK_REGION}" \
  --from-literal=BEDROCK_MODEL_ID="${BEDROCK_MODEL_ID}" \
  --from-literal=BEDROCK_TIMEOUT_MS=180000 \
  --from-literal=S3_BUCKET="${REPORT_BUCKET}" \
  --from-literal=S3_REGION="${AWS_REGION}" \
  --from-literal=S3_PREFIX="${REPORT_PREFIX}" \
  --from-literal=AWS_REGION="${AWS_REGION}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

if [[ -z "${IMAGE_TAG:-}" ]]; then
  IMAGE_TAG="$(git -C "${PROJECT_ROOT}" rev-parse --short=12 HEAD)"
  if [[ -n "$(git -C "${PROJECT_ROOT}" status --porcelain --untracked-files=normal)" ]]; then
    IMAGE_TAG="${IMAGE_TAG}-dirty-$(date -u +%Y%m%d%H%M%S)"
  fi
fi
[[ "${IMAGE_TAG}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail "IMAGE_TAG 형식이 올바르지 않습니다."
IMAGE_URI="${REPOSITORY_URI}:${IMAGE_TAG}"

if aws ecr describe-images \
  --region "${AWS_REGION}" \
  --repository-name "${ECR_REPOSITORY}" \
  --image-ids imageTag="${IMAGE_TAG}" >/dev/null 2>&1; then
  log "ECR에 ${IMAGE_TAG} 이미지가 있어 빌드와 푸시를 건너뜁니다."
else
  log "linux/amd64 Docker 이미지를 빌드해 ECR에 업로드합니다."
  ECR_REGISTRY="${REPOSITORY_URI%/*}"
  aws ecr get-login-password --region "${AWS_REGION}" | \
    docker login --username AWS --password-stdin "${ECR_REGISTRY}" >/dev/null
  docker build \
    --platform linux/amd64 \
    --pull \
    --tag "${IMAGE_URI}" \
    "${PROJECT_ROOT}"
  docker push "${IMAGE_URI}"
fi

log "애플리케이션 Deployment와 인터넷 공개 NLB Service를 적용합니다."
sed "s|__IMAGE_URI__|${IMAGE_URI}|g" "${APP_MANIFEST}" | kubectl apply -f - >/dev/null
kubectl rollout status deployment/portfolio-lens \
  --namespace "${NAMESPACE}" \
  --timeout 10m

log "NLB DNS 이름이 할당되기를 기다립니다."
LOAD_BALANCER_HOST=""
for _ in $(seq 1 90); do
  LOAD_BALANCER_HOST="$(kubectl get service portfolio-lens \
    --namespace "${NAMESPACE}" \
    --output jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
  [[ -n "${LOAD_BALANCER_HOST}" ]] && break
  sleep 10
done
[[ -n "${LOAD_BALANCER_HOST}" ]] || fail "15분 안에 NLB DNS 이름이 할당되지 않았습니다."

if [[ -n "${PUBLIC_APP_URL:-}" ]]; then
  FINAL_PUBLIC_APP_URL="${PUBLIC_APP_URL%/}"
else
  FINAL_PUBLIC_APP_URL="http://${LOAD_BALANCER_HOST}"
fi
[[ "${FINAL_PUBLIC_APP_URL}" =~ ^https?:// ]] || fail "PUBLIC_APP_URL은 http:// 또는 https://로 시작해야 합니다."

kubectl set env deployment/portfolio-lens \
  --namespace "${NAMESPACE}" \
  PUBLIC_APP_URL="${FINAL_PUBLIC_APP_URL}" >/dev/null
kubectl rollout status deployment/portfolio-lens \
  --namespace "${NAMESPACE}" \
  --timeout 10m

HEALTH_URL="http://${LOAD_BALANCER_HOST}/api/health"
HEALTH_FILE="${TMP_DIR}/health.json"
log "NLB를 통한 애플리케이션 상태와 RDS/S3/Bedrock 설정을 검증합니다."
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 10 "${HEALTH_URL}" >"${HEALTH_FILE}" 2>/dev/null; then
    break
  fi
  sleep 10
done
[[ -s "${HEALTH_FILE}" ]] || fail "애플리케이션 상태 확인에 실패했습니다: ${HEALTH_URL}"
jq -e '
  .status == "ok" and
  .storage == "mysql" and
  .reportStorage == "s3" and
  .reportGeneration == "configured"
' "${HEALTH_FILE}" >/dev/null || fail "상태 응답이 MySQL, S3, AI 보고서 활성화를 모두 확인하지 못했습니다."

log "배포가 완료되었습니다."
printf 'Application URL: %s\n' "${FINAL_PUBLIC_APP_URL}"
printf 'Load balancer health: %s\n' "${HEALTH_URL}"
printf 'Image: %s\n' "${IMAGE_URI}"
printf 'Upstream read-only Toss-compatible API: https://tpl.uaysk.com/\n'
if [[ "${FINAL_PUBLIC_APP_URL}" == http://* ]]; then
  printf '주의: 현재 NLB 주소는 HTTP입니다. 로그인 정보를 입력하기 전에 ACM 인증서와 사용자 도메인으로 HTTPS를 구성하세요.\n' >&2
fi
