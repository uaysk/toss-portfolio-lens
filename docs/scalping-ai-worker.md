# 단타 보조 AI worker 운영 경계

단타 보조의 공개 시계열 모델은 Node control plane, 메인 web image, Rust worker에 포함되지 않는다.
`Dockerfile.worker.ai`의 Kronos와 `Dockerfile.worker.fincast`의 FinCast가 서로 다른 image·process·token으로
예측과 retrospective 평가를 수행하며 주문을 전송하지 않는다. 각 worker는 요청 하나만 직렬 처리하고 다른
모델의 출력을 fallback처럼 반환하지 않는다.

## 기본 Compose 토폴로지

프로필 없이 `docker compose up`을 실행하면 Kronos `ai-worker`만 같은 스택에서 시작된다.
FinCast는 모델 cache·precision qualification·VRAM headroom 검증이 끝난 뒤에만 `fincast` profile로
명시적으로 추가한다. 기본 구성은 다음과 같다.

- web은 Kronos `ws://ai-worker:8765/ws/scalping-ai/v1`, FinCast
  `ws://fincast-worker:8766/ws/scalping-ai/v1`에 동일 origin·512봉 입력을 순차 전송한다.
- 두 worker는 외부 port를 publish하지 않고 `internal: true`인 `ai_internal` network에만 연결된다.
- web은 provider API 접근용 기본 network와 AI 전용 network에 함께 연결된다.
- 기본 `AI_DEVICE=cuda`, `AI_ALLOW_CPU_FALLBACK=false`이며 GPU device reservation이 없으면 모델을
  실행한 척하지 않고 unavailable로 남는다.
- `ai_auth`와 `fincast_auth`는 서로 다른 token volume이며 web에는 각각 read-only로 mount된다.
- worker는 token이 없을 때만 각자의 `/app/ai-auth/token` 또는 `/app/fincast-auth/token`을 원자 생성한다.
  web은 동일 파일을 지연 읽기하고 재연결한다.
- 두 image의 auth directory는 UID/GID 10001 소유로 준비되므로 새 named volume의 초기 권한도 이를 따른다.
- model cache 기본값은 빈 `ai_model_cache` named volume이다. 모델이 없으면 worker는 값을 만들지 않고
  `MODEL_UNAVAILABLE`을 반환한다.

토큰 값은 환경변수, Compose 파일, image, Git, 명령 출력, 로그에 넣지 않는다. volume에는 token file만 두며
애플리케이션 요청에는 bearer 인증으로 사용한다.

```bash
docker compose build ai-worker
docker compose up -d
docker compose ps ai-worker web

# FinCast qualification 완료 후에만 실행
docker compose --profile fincast build fincast-worker
AI_FINCAST_COMPUTE_URL=ws://fincast-worker:8766/ws/scalping-ai/v1 \
  docker compose --profile fincast up -d fincast-worker web
```

로컬 GPU에서 실제 추론할 때 GPU override를 추가한다.

```bash
docker compose -f compose.yaml -f compose.ai-gpu.yaml up --build -d ai-worker web

# FinCast qualification 완료 후에만 실행
AI_FINCAST_COMPUTE_URL=ws://fincast-worker:8766/ws/scalping-ai/v1 \
  docker compose -f compose.yaml -f compose.ai-gpu.yaml \
    --profile fincast up --build -d fincast-worker web
```

`compose.ai-gpu.yaml`은 NVIDIA GPU 한 개를 예약하고 CPU fallback을 계속 비활성화한다. 기본 image와 web
image는 바뀌지 않는다.

## 고정 모델과 명시적 cache 준비

Kronos 모델·tokenizer와 FinCast 모델·source·논문 revision 및 SHA-256은
[`worker/ai/model-manifest.json`](../worker/ai/model-manifest.json)에 고정되어 있다. runtime은 Hugging Face와
Transformers offline 모드로 실행하고 `/models`를 read-only로 mount한다. revision marker나 필수 파일이
없으면 시작 중 다운로드하지 않고 unavailable 상태를 제공한다.

각 프로세스는 pinned `NeoQuasar/Kronos-base` 또는 `Vincent05R/FinCast` lane 하나만 실행한다. 응답의
`model_runs`도 해당 role 하나만 포함하고 top-level model·status·series가 그 결과를 그대로 반영한다.
model/tokenizer/source revision,
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

### FinCast 격리 변환과 precision qualification

공식 `v1.pth`는 runtime에서 절대 읽지 않는다. provisioning 환경에서만 source archive와 checkpoint SHA-256을
manifest와 대조하고 `torch.load(..., weights_only=True)`로 연다. meta device에 만든 공식 4-expert/top-2
architecture와 key·shape·dtype가 정확히 같은지 확인한 뒤 원본 FP32 safetensors와 mixed FP16 후보를 만든다.

변환은 runtime container와 분리된 일회성 sandbox에서 실행한다. 아래의 repository와 input directory는
read-only이고, 비어 있는 cache directory만 UID/GID 10001에 쓰기를 허용한다. sandbox는 network, Linux
capability, privilege escalation과 writable root filesystem이 없으며 pickle checkpoint는 이 단계 밖에서
열리지 않는다.

```bash
install -d -m 0755 /absolute/offline/fincast-model-cache
chown 10001:10001 /absolute/offline/fincast-model-cache

docker run --rm \
  --network none \
  --read-only \
  --user 10001:10001 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 256 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g \
  --env PYTHONDONTWRITEBYTECODE=1 \
  --env UV_OFFLINE=1 \
  --env NVIDIA_DRIVER_CAPABILITIES=compute,utility \
  --entrypoint /app/.venv/bin/python \
  --mount type=bind,src=/absolute/reviewed/scripts/prepare-fincast-model-cache.py,dst=/provision/prepare.py,readonly \
  --mount type=bind,src=/secure/provisioning/488b19d.tar.gz,dst=/inputs/source.tar.gz,readonly \
  --mount type=bind,src=/secure/provisioning/v1.pth,dst=/inputs/v1.pth,readonly \
  --mount type=bind,src=/absolute/offline/fincast-model-cache,dst=/output \
  toss-portfolio-lens-fincast-worker@sha256:CANDIDATE_IMAGE_DIGEST \
  /provision/prepare.py \
  --manifest /app/model-manifest.json \
  --cache-dir /output \
  --source-archive /inputs/source.tar.gz \
  --checkpoint /inputs/v1.pth
```

위 `repository@sha256:...` 표기는 registry에서 pull한 image의 RepoDigest 예시다. worker-1에서 로컬 build한
image는 RepoDigest가 없을 수 있으므로 `docker image inspect --format '{{.Id}}' <immutable-tag>`가 반환한 전체
`sha256:...` Image ID를 그대로 사용한다. 변환, qualification, preflight와 최종 Compose의
`AI_FINCAST_WORKER_IMAGE`가 모두 같은 Image ID를 가리켜야 하며, 이 사이에는 `pull` 또는 `--build`를 실행하지
않는다. Compose 기동에는 `--no-build --pull never`를 사용하고, 기동 후 container의 `.Image`가 후보 Image ID와
정확히 같은지 다시 확인한다.

GPU qualification도 같은 offline sandbox 경계를 유지하되 대상 P40만 추가한다. qualification이
`precision-validation.json`을 원자 기록한 뒤 cache는 runtime에 항상 read-only로 mount한다.

```bash
docker run --rm \
  --gpus all \
  --network none \
  --read-only \
  --user 10001:10001 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 256 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g \
  --env PYTHONDONTWRITEBYTECODE=1 \
  --env UV_OFFLINE=1 \
  --env NVIDIA_DRIVER_CAPABILITIES=compute,utility \
  --entrypoint /app/.venv/bin/python \
  --mount type=bind,src=/absolute/reviewed/scripts/validate-fincast-precision.py,dst=/provision/validate.py,readonly \
  --mount type=bind,src=/absolute/reviewed/worker/ai/tests/fixtures/fincast-crypto-contexts.json,dst=/inputs/contexts.json,readonly \
  --mount type=bind,src=/absolute/offline/fincast-model-cache,dst=/models \
  toss-portfolio-lens-fincast-worker@sha256:CANDIDATE_IMAGE_DIGEST \
  /provision/validate.py \
  --manifest /app/model-manifest.json \
  --cache-dir /models \
  --contexts /inputs/contexts.json
```

qualification 직후 같은 image digest와 cache를 network 없이 다시 열어 runtime preflight를 통과시킨다.
이 검사는 `Tesla P40`, compute capability 6.1, 호환 cubin, NVML, 선택 precision artifact와 load 후 VRAM
headroom을 모두 실제 container에서 확인한다.

```bash
docker run --rm \
  --gpus all \
  --network none \
  --read-only \
  --user 10001:10001 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  --env PYTHONDONTWRITEBYTECODE=1 \
  --env UV_OFFLINE=1 \
  --env NVIDIA_DRIVER_CAPABILITIES=compute,utility \
  --mount type=bind,src=/absolute/offline/fincast-model-cache,dst=/models,readonly \
  --entrypoint /app/.venv/bin/portfolio-ai-worker \
  toss-portfolio-lens-fincast-worker@sha256:CANDIDATE_IMAGE_DIGEST \
  preflight-json
```

Compose healthcheck는 listener liveness만 검사하므로 모델 qualification gate로 사용하지 않는다. 위
`preflight-json`이 exit code 0이고 `status=available`, `model.loaded=true`, P40/6.1, 승인된 precision,
`memory_status=ok`를 모두 보고해야 배포할 수 있다. 배포 뒤에는 별도 token으로 인증한 worker status에서도
FinCast lane이 `available`인지 확인한다.

고정 fixture는 credential 없이 Binance USD-M의 16개 USDT 무기한 계약에서 캡처한 완결 1분봉
`128 source contexts × 512 bars`이며 content SHA-256도 manifest에 고정한다. v4 qualification은 여기에 첫
context 전체를 마지막 close가 각각 `131072`, `0.00001`이 되도록 비례 조정한 2개 scale-stress context를
추가한다. 이렇게 만든 130개 context 각각을 decoder의 native `15초 × 240 steps`,
`30초 × 120 steps`, `60초 × 60 steps` horizon shape로 실행하므로 총 390 cases,
54,600 quantile rows를 FP32와 mixed FP16 양쪽에서 평가한다. 입력 fixture 자체는 1분 close context이며,
15/30/60초 값은 이 qualification에서 decoder output shape와 각 row의 비용 초과 방향 채점에 결합된다.

validation v4는 실행 환경도 `torch 2.6.0`, CUDA runtime `12.4`, `Tesla P40`, compute capability `6.1`로
고정한다. qualification 및 이후 runtime이 이 네 값을 모두 정확히 재현하지 않으면 validation을 거부한다.
수치 gate는 NaN/Inf, quantile 단조성, Node와 같은 cost-exceeding quantile CDF 방향(0.55 threshold) 99%,
FP32 IQR 대비 q50 중앙/p95 오차 5%/15%, `max(cuda allocated, cuda reserved)` peak VRAM 25% 절감을
모두 검사한다. 하나라도 실패하면 original FP32 safetensors를 선택한다. validation file이나 artifact SHA가
없으면 runtime은 시작 시 다운로드하지 않고 unavailable이다.

mixed lane은 weights/일반 activation을 FP16으로 두되 공식 decoder의 attention softmax와 RMSNorm FP32 계산을
유지하고, MoE RMSNorm/router logits는 reviewed hook으로 FP32 계산 후 activation dtype으로 복귀한다. 최종
quantile 후처리도 FP32다. 교차하는 FinCast native decile은 FP32 최종 후처리에서 결정론적 오름차순
monotone rearrangement를 적용하고, q10~q90 밖의 q05/q95는 외삽하지 않고 q10/q90으로 clamp한다.
교차 정책 `fp32_monotone_rearrangement_v1`과 tail 정책 `tail_clamped_q10_q90`을 provenance에
서로 분리해 기록한다. forecast provenance에는 FP32와 mixed qualification 각각의 전체 row 수,
non-finite 수, crossing row·인접 pair 수, adjusted row 수, adjusted row만을 분모로 계산한 q50
adjustment/FP32 IQR median·p95·max와 후처리 단조성도 기록한다. public worker status에는 이 수치
객체를 넣지 않고 precision·validation·memory·policy enum만 노출한다.

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

GPU 호스트의 Kronos 1차 `.env` 예시:

```text
AI_WORKER_IMAGE=harbor.uaysk.com/toss-portfolio-lens/kronos-worker@sha256:<manifest-digest>
AI_REMOTE_BIND_ADDRESS=172.30.1.14
AI_KRONOS_REMOTE_PORT=18765
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

FinCast qualification 뒤에는 별도 변수와 overlay를 추가한다. `compose.ai-remote-worker.yaml`만으로는
FinCast cache·token을 요구하지 않으며 18766을 열지 않는다.

이 forecast provenance 추가는 transport v1 안의 additive 필드이지만 새 control plane에서는 loaded FinCast에
필수다. 따라서 새 이미지를 qualification·probe하고 FinCast worker service를 먼저 배포한 뒤 control plane을
배포한다. 새 control plane에 이전 FinCast worker를 연결하면 안 되며, 순서를 되돌려야 할 때는 두 구성요소를
함께 이전 digest로 rollback한다.

```text
AI_FINCAST_WORKER_IMAGE=harbor.uaysk.com/toss-portfolio-lens/fincast-worker@sha256:<manifest-digest>
AI_FINCAST_REMOTE_PORT=18766
AI_FINCAST_MODEL_CACHE_SOURCE=/opt/toss-portfolio-lens/fincast-model-cache
AI_FINCAST_AUTH_SECRET_SOURCE=/opt/toss-portfolio-lens/fincast-auth
```

```bash
docker compose \
  -f compose.yaml \
  -f compose.ai-gpu.yaml \
  -f compose.ai-remote-worker.yaml \
  -f compose.ai-remote-fincast.yaml \
  --profile fincast pull fincast-worker

docker compose \
  -f compose.yaml \
  -f compose.ai-gpu.yaml \
  -f compose.ai-remote-worker.yaml \
  -f compose.ai-remote-fincast.yaml \
  --profile fincast up -d --no-deps fincast-worker
```

원격 worker override는 web·Rust services를 비활성 profile로 옮기므로 main services는 GPU 서버에서
시작되지 않는다.

## 원격 main 연결

main 호스트는 같은 token directory를 read-only로 mount하고 원격 URL을 설정한다.
`compose.ai-remote-main.yaml`은 local `ai-worker`와 `fincast-worker`를 비활성 profile로 옮기므로 일반 `up`에도 중복 worker가
시작되지 않는다.

TLS가 없는 private LAN에서만 다음 opt-in을 허용한다.

```text
AI_COMPUTE_URL=ws://172.30.1.14:18765/ws/scalping-ai/v1
AI_KRONOS_COMPUTE_URL=ws://172.30.1.14:18765/ws/scalping-ai/v1
AI_FINCAST_COMPUTE_URL=ws://172.30.1.14:18766/ws/scalping-ai/v1
CRYPTO_SIMULATION_MAX_ACTIVE_SESSIONS=1
AI_COMPUTE_ALLOW_INSECURE_PRIVATE_WS=true
AI_AUTH_SECRET_SOURCE=/opt/toss-portfolio-lens/ai-auth
AI_FINCAST_AUTH_SECRET_SOURCE=/opt/toss-portfolio-lens/fincast-auth
```

`CRYPTO_SIMULATION_MAX_ACTIVE_SESSIONS`는 주식의
`SCALPING_SIMULATION_MAX_ACTIVE_SESSIONS`와 독립적이며 기본값은 1이다. 같은 crypto GPU lane에
두 paper session이 동시에 추론을 요청하지 않도록 운영에서는 1을 유지한다.

```bash
docker compose -f compose.yaml -f compose.ai-remote-main.yaml up -d web compute-ipc
```

평문 `ws`는 RFC1918 private 주소에서 명시적으로 opt-in한 경우만 사용한다. 방화벽도 main host 주소에서 오는
TCP만 허용해야 한다. public route, 서로 신뢰할 수 없는 VLAN, 인터넷 구간에서는 반드시 `wss` 또는 TLS
reverse proxy를 사용한다.

직접 TLS를 종료할 때 Kronos GPU worker는 `AI_TLS_SECRET_SOURCE`,
`AI_WEBSOCKET_TLS_CERT_FILE`, `AI_WEBSOCKET_TLS_KEY_FILE`을 사용한다. FinCast GPU worker는 독립된
`AI_FINCAST_TLS_SECRET_SOURCE`, `AI_FINCAST_WEBSOCKET_TLS_CERT_FILE`,
`AI_FINCAST_WEBSOCKET_TLS_KEY_FILE`을 사용한다. cert/key 경로는 각 worker의 `/run/ai-tls` 아래 container
경로이며 두 값을 함께 설정해야 한다. main은 `wss://` URL을 사용한다. private CA라면 main의
`AI_TLS_SECRET_SOURCE`에 CA를 mount하고 `AI_COMPUTE_TLS_CA_FILE=/run/ai-tls/ca.crt`를 지정한다.

## P40 정책과 검증 경계

Tesla P40은 Pascal compute capability 6.1이다. worker는 관찰한 CUDA 장치명이
`AI_EXPECTED_CUDA_DEVICE_NAME`(기본 `Tesla P40`)과 정확히 일치하는지도 검사한다. 장치명이 없거나 다르면
production 모델 run은 unavailable로 fail-closed된다. PyTorch wheel에 같은 major의 하위 minor cubin인 `sm_60`이
포함돼 있으면 NVIDIA binary compatibility에 따라 P40에서 허용한다. exact `sm_61` cubin만을 요구하지 않는다.
Kronos는 float32/math SDPA를 사용한다. FinCast는 qualification이 통과한 mixed FP16 또는 lossless FP32
fallback을 사용하며 NVML free memory가 검증 peak와 `AI_FINCAST_MIN_VRAM_HEADROOM_MIB` 합보다 작으면
`memory_pressure`로 fail-closed한다. forecast 응답은 bounded qualification 관측치를 포함하지만 public
status는 precision, validation, memory 상태와 monotonicity/tail policy enum만 기록한다. 어느 쪽도
credential이나 세부 키 정보를 포함하지 않는다.

다음 항목은 서로 다른 검증이다.

- `docker compose config`: 구성 병합과 필수 환경변수 검증
- `portfolio-ai-worker healthcheck`: 모델을 load하지 않는 local TCP listener liveness 확인
- `preflight-json`: cache revision, 모델 load, CUDA 장치명·capability 확인
- batch forecast: 실제 VRAM peak, latency, 여러 종목 응답 확인
- main→worker round-trip: 인증, WebSocket, firewall, timeout, reconnect 확인

정적 구성이나 host의 `nvidia-smi` 성공만으로 P40 container 추론을 완료했다고 표현하면 안 된다.
