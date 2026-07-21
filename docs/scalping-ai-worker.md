# 단타 보조 AI worker 운영 경계

단타 보조의 공개 시계열 모델은 Node control plane이나 Rust 계산 worker에 포함되지 않는다. 선택적
`ai-worker` 컨테이너가 `scalping-ai/v1` UDS 계약으로 예측과 retrospective 평가만 수행하며, 주문을 만들거나
기술 신호를 대신 결정하지 않는다.

## 고정 모델과 오프라인 캐시

기본 모델은 Kronos-small이고, 시작 시 호환성 문제가 있을 때만 Chronos-Bolt-small을 fallback으로 검토한다.
모델·tokenizer·Kronos source의 정확한 revision과 라이선스는
[`worker/ai/model-manifest.json`](../worker/ai/model-manifest.json)에 고정되어 있다. 컨테이너는 다음을 보장한다.

- Hugging Face와 Transformers를 offline 모드로 실행하고 네트워크 자체를 비활성화한다.
- `AI_MODEL_CACHE_HOST_PATH`를 `/models`에 읽기 전용으로 마운트한다.
- 각 snapshot의 revision marker가 manifest와 정확히 일치하지 않으면 `unavailable`을 반환한다.
- image build와 worker 시작 과정에서 모델을 내려받거나 임의 예측을 생성하지 않는다.

캐시 디렉터리는 [`worker/ai/README.md`](../worker/ai/README.md)의 레이아웃을 따라 별도의 검토된 절차로
준비한다. 기본 호스트 경로는 `./data/ai-model-cache`이며, 디렉터리가 없으면 Compose가 자동 생성하지 않고
시작을 중단한다.

## P40-safe 실행

`scalping-ai` 프로필은 GPU 한 개를 예약하고 기본적으로 CUDA를 요청한다. Tesla P40의 Pascal compute
capability `6.1`, float32, math SDPA를 사용하며 FlashAttention이나 bf16에 의존하지 않는다. 설치된 PyTorch
wheel에 `sm_61`이 없거나 실제 장치 capability가 다르면 preflight가 실패한다. `AI_ALLOW_CPU_FALLBACK=true`는
CUDA를 사용할 수 없을 때 명시적인 CPU fallback을 허용하지만, 응답 provenance에는 실제 device가 기록된다.

실제 P40에서의 모델 로딩·batch 추론·VRAM·지연시간은 아직 검증되지 않았다. compose 정적 검증이나 CPU
테스트를 P40 추론 검증으로 간주하면 안 된다.

## 선택적 실행과 점검

단타 보조를 사용하지 않을 때 `ai-worker`는 시작되지 않으며 Node도 AI socket을 호출하지 않는다. 사용하려면
provider 실측 한도를 포함한 `SCALPING_ENABLED=true` 설정과 모델 캐시를 먼저 준비한 뒤 선택 프로필을 지정한다.

```bash
AI_MODEL_CACHE_HOST_PATH=/absolute/read-only/cache \
  docker compose --profile scalping-ai up --build -d web compute-ipc ai-worker
```

컨테이너를 시작하기 전에 동일 이미지와 캐시로 모델·장치 preflight만 실행할 수 있다. 이 명령은 모델을
다운로드하지 않지만 캐시 파일을 실제로 읽고 모델을 로드하므로 GPU 노드에서 실행해야 P40 검증이 된다.

```bash
AI_MODEL_CACHE_HOST_PATH=/absolute/read-only/cache \
  docker compose --profile scalping-ai run --rm --no-deps ai-worker preflight-json
```

정상 실행 시 Node와 AI worker는 공통 `compute_socket` volume의 `/app/run/ai.sock`만 공유한다. AI worker는
Docker network에 연결되지 않는다. 컨테이너 healthcheck는 UDS accept 여부만 확인하며 모델 품질이나 P40 추론
성능을 증명하지 않는다.

종료는 해당 선택 서비스만 대상으로 한다.

```bash
docker compose --profile scalping-ai stop ai-worker
```
