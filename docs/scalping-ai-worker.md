# 단타 보조 AI worker 운영 경계

단타 보조의 공개 시계열 모델은 Node control plane, 메인 web image, Rust worker에 포함되지 않는다.
`Dockerfile.worker.ai`로만 빌드되는 별도 `${AI_WORKER_IMAGE}`가 예측과 retrospective 평가를 수행하며 주문이나
기술 신호를 결정하지 않는다. PyTorch·CUDA·Kronos 의존성은 AI image에만 설치되므로 원격 GPU 서버는
이 image와 `ai-worker` 서비스만 pull/build/run할 수 있다.

## 기본 Compose 토폴로지

프로필 없이 `docker compose up`을 실행하면 `ai-worker`도 같은 스택에서 시작된다. 기본 구성은 다음과 같다.

- web은 `ws://ai-worker:8765/ws/scalping-ai/v1`에 연결한다.
- `ai-worker`는 외부 port를 publish하지 않고 `internal: true`인 `ai_internal` network에만 연결된다.
- web은 provider API 접근용 기본 network와 AI 전용 network에 함께 연결된다.
- 기본 `AI_DEVICE=cuda`, `AI_ALLOW_CPU_FALLBACK=false`이며 GPU device reservation이 없으면 모델을
  실행한 척하지 않고 unavailable로 남는다.
- `ai_auth` named volume은 worker의 `/app/ai-auth`에 read-write, web의 `/run/ai-auth`에 read-only로 mount된다.
- worker는 token이 없을 때만 `/app/ai-auth/token`을 원자 생성한다. web은 동일 파일을 지연 읽기하고 재연결한다.
- image의 `/app/ai-auth`는 UID/GID 10001 소유로 준비되므로 새 named volume의 초기 권한도 이를 따른다.
- model cache 기본값은 빈 `ai_model_cache` named volume이다. 모델이 없으면 worker는 값을 만들지 않고
  `MODEL_UNAVAILABLE`을 반환한다.

토큰 값은 환경변수, Compose 파일, image, Git, 명령 출력, 로그에 넣지 않는다. volume에는 token file만 두며
애플리케이션 요청에는 bearer 인증으로 사용한다.

```bash
docker compose build ai-worker
docker compose up -d
docker compose ps ai-worker web
```

로컬 GPU에서 실제 추론할 때 GPU override를 추가한다.

```bash
docker compose -f compose.yaml -f compose.ai-gpu.yaml up --build -d ai-worker web
```

`compose.ai-gpu.yaml`은 NVIDIA GPU 한 개를 예약하고 CPU fallback을 계속 비활성화한다. 기본 image와 web
image는 바뀌지 않는다.

## 고정 모델과 명시적 cache 준비

모델·tokenizer·Kronos source revision은
[`worker/ai/model-manifest.json`](../worker/ai/model-manifest.json)에 고정되어 있다. runtime은 Hugging Face와
Transformers offline 모드로 실행하고 `/models`를 read-only로 mount한다. revision marker나 필수 파일이
없으면 시작 중 다운로드하지 않고 unavailable 상태를 제공한다.

실행 모델은 pinned `NeoQuasar/Kronos-base` 하나다. worker 응답은 `model_runs`에 `kronos_base` role 하나만
포함하고 top-level model·status·series도 그 결과를 그대로 반영한다. model/tokenizer/source revision,
`input_end_at`, 확정봉 수와 digest, 생성 시각, device와 latency를 응답에 남긴다. cache 또는 CUDA/P40 실행
조건을 충족하지 못하면 fallback이나 임의 출력 없이 run을 unavailable로 반환한다.

준비 스크립트는 manifest에 고정된 Kronos-base와 `Kronos-Tokenizer-base` snapshot만 준비한다. 이 명령은
runtime과 분리된 운영자 작업이며 외부 다운로드가 허용된 시점과 호스트에서만 실행한다.

```bash
uv run --python 3.12 --with huggingface-hub==0.33.1 \
  python scripts/prepare-ai-model-cache.py \
  --cache-dir /absolute/offline/ai-model-cache

python3 scripts/prepare-ai-model-cache.py \
  --cache-dir /absolute/offline/ai-model-cache \
  --check-only
```

스크립트는 manifest의 정확한 revision으로 임시 sibling directory에 내려받고 `config.json`과
`model.safetensors`가 실제 regular file인지 확인한 다음 `.revision`을 원자 기록한다. 기존 invalid directory는
덮어쓰지 않는다. Kronos source는 별도 검토 절차로 manifest의 정확한 revision을 `kronos-source`에 준비한다.
완성된 cache에는 `kronos-base`, `kronos-tokenizer-base`, `kronos-source` 세 directory가 있어야 한다.
public model cache directory는 container UID 10001이 탐색할 수 있도록 보통 `0755`, 필수 artifact는 read-only로
둔다.

페어 가상매매에서 Node control plane은 이 Kronos-base 출력과 같은 origin의 Rust 기술 신호만
`pair-ensemble-policy/v2`로 결합한다. Kronos-base 또는 Rust가 unavailable/stale이거나 origin이 다르면
가중치를 재분배하지 않고 cash로 fail-closed한다. Kronos-base 단독과 Rust 단독 lane은 같은 체결 조건의
비교·검증용이며 실제 forward 원장은 Kronos-base+Rust 앙상블 결정만 체결한다.

호스트 cache를 mount할 때 `.env`에 절대 경로를 지정한다. 이 경로와 `data/`는 Git 대상이 아니다.

```text
AI_MODEL_CACHE_SOURCE=/absolute/offline/ai-model-cache
```

## 원격 GPU worker

GPU 호스트에는 repository checkout 또는 미리 publish한 `${AI_WORKER_IMAGE}`만 준비한다. web image와 Rust image를
build하거나 실행할 필요가 없다. token은 안전한 secret 전달 경로로 한 번 생성한 뒤 main과 GPU 두 호스트의
전용 directory에 동일한 값으로 사전 배치한다. 두 컨테이너 모두 UID 10001이므로 directory는 `0700`, token은
UID/GID 10001 소유의 `0400`을 권장한다. 자동 생성은 원격 worker에서 비활성화된다.
main host의 `.env`는 GPU host로 복사하지 않는다. base Compose의 `.env` reference는 `required: false`라서 아래
AI 전용 변수만 GPU host에서 별도로 제공하면 된다.

GPU 호스트 `.env` 예시:

```text
AI_WORKER_IMAGE=registry.example/toss-portfolio-lens-ai-worker:<immutable-tag>
AI_REMOTE_BIND_ADDRESS=172.30.1.14
AI_REMOTE_PORT=18765
AI_MODEL_CACHE_SOURCE=/opt/toss-portfolio-lens/ai-model-cache
AI_AUTH_SECRET_SOURCE=/opt/toss-portfolio-lens/ai-auth
AI_DEVICE=cuda
AI_ALLOW_CPU_FALLBACK=false
AI_EXPECTED_CUDA_CAPABILITY=6.1
AI_EXPECTED_CUDA_DEVICE_NAME=Tesla P40
```

`AI_REMOTE_BIND_ADDRESS`는 `0.0.0.0`이나 public interface가 아닌 GPU 서버의 private LAN 주소로 고정한다.
원격 override는 Docker가 published port ingress를 설치할 수 있도록 AI network의 `internal` 속성만 해제한다.
기본 동일 호스트 Compose의 internal network는 유지된다. 따라서 원격 배치에서는 host firewall로 main host의
접근만 허용하고, runtime의 offline model 정책과 bearer token 인증을 함께 유지해야 한다.
이미지를 registry에서 받을 때는 `pull`, 현 checkout에서 만들 때는 `build` 중 하나를 선택한다.

```bash
docker compose \
  -f compose.yaml \
  -f compose.ai-gpu.yaml \
  -f compose.ai-remote-worker.yaml \
  pull ai-worker

docker compose \
  -f compose.yaml \
  -f compose.ai-gpu.yaml \
  -f compose.ai-remote-worker.yaml \
  up -d --no-deps ai-worker
```

override는 web·Rust services를 비활성 profile로 옮기고 명령도 `ai-worker`만 지정하므로 main services는 원격
GPU 서버에서 시작되지 않는다.

## 원격 main 연결

main 호스트는 같은 token directory를 read-only로 mount하고 원격 URL을 설정한다.
`compose.ai-remote-main.yaml`은 local `ai-worker`를 비활성 profile로 옮기므로 일반 `up`에도 중복 worker가
시작되지 않는다.

TLS가 없는 private LAN에서만 다음 opt-in을 허용한다.

```text
AI_COMPUTE_URL=ws://172.30.1.14:18765/ws/scalping-ai/v1
AI_COMPUTE_ALLOW_INSECURE_PRIVATE_WS=true
AI_AUTH_SECRET_SOURCE=/opt/toss-portfolio-lens/ai-auth
```

```bash
docker compose -f compose.yaml -f compose.ai-remote-main.yaml up -d web compute-ipc
```

평문 `ws`는 RFC1918 private 주소에서 명시적으로 opt-in한 경우만 사용한다. 방화벽도 main host 주소에서 오는
TCP만 허용해야 한다. public route, 서로 신뢰할 수 없는 VLAN, 인터넷 구간에서는 반드시 `wss` 또는 TLS
reverse proxy를 사용한다.

직접 TLS를 종료할 때 GPU 호스트의 `AI_TLS_SECRET_SOURCE`를 certificate directory로 지정하고
`AI_WEBSOCKET_TLS_CERT_FILE`과 `AI_WEBSOCKET_TLS_KEY_FILE`을 `/run/ai-tls` 아래 container 경로로 설정한다.
main은 `wss://` URL을 사용한다. private CA라면 main의 `AI_TLS_SECRET_SOURCE`에 CA를 mount하고
`AI_COMPUTE_TLS_CA_FILE=/run/ai-tls/ca.crt`를 지정한다. cert와 key는 둘 다 있어야 worker가 TLS를 활성화한다.

## P40 정책과 검증 경계

Tesla P40은 Pascal compute capability 6.1이다. worker는 관찰한 CUDA 장치명이
`AI_EXPECTED_CUDA_DEVICE_NAME`(기본 `Tesla P40`)과 정확히 일치하는지도 검사한다. 장치명이 없거나 다르면
production 모델 run은 unavailable로 fail-closed된다. PyTorch wheel에 같은 major의 하위 minor cubin인 `sm_60`이
포함돼 있으면 NVIDIA binary compatibility에 따라 P40에서 허용한다. exact `sm_61` cubin만을 요구하지 않는다.
float32와 math SDPA를 사용하고 FlashAttention·bf16에 의존하지 않는다. 실제 응답 provenance에는 선택된
device와 attention backend가 기록된다.

다음 항목은 서로 다른 검증이다.

- `docker compose config`: 구성 병합과 필수 환경변수 검증
- `portfolio-ai-worker healthcheck`: 모델을 load하지 않는 local TCP listener liveness 확인
- `preflight-json`: cache revision, 모델 load, CUDA 장치명·capability 확인
- batch forecast: 실제 VRAM peak, latency, 여러 종목 응답 확인
- main→worker round-trip: 인증, WebSocket, firewall, timeout, reconnect 확인

정적 구성이나 host의 `nvidia-smi` 성공만으로 P40 container 추론을 완료했다고 표현하면 안 된다.
