# FinCast·Chronos‑2 AI worker

AI worker는 `worker/ai`의 동일한 코드로 FinCast와 Chronos‑2 lane을 각각 실행한다. 두 lane 모두 인증된 `/ws/scalping-ai/v2` 계약만 제공하며 모델 identity, revision, 입력 digest와 실행 provenance를 응답에 포함한다.

## 실행

```bash
docker compose --profile fincast up --build -d fincast-worker
docker compose --profile chronos2 up --build -d chronos2-worker
```

웹 서버에는 lane별 endpoint와 서로 다른 mode-600 token 파일을 설정한다.

```dotenv
AI_FINCAST_COMPUTE_URL=ws://fincast-worker:8766/ws/scalping-ai/v2
AI_FINCAST_AUTH_SECRET_SOURCE=/run/secrets/ai-fincast-auth-token
AI_CHRONOS2_COMPUTE_URL=ws://chronos2-worker:8767/ws/scalping-ai/v2
AI_CHRONOS2_AUTH_SECRET_SOURCE=/run/secrets/ai-chronos2-auth-token
```

원격 endpoint에는 `wss://`와 검증 가능한 CA를 사용한다. 사설망의 평문 `ws://`는 lane별 명시적 허용 설정이 있는 개발 환경에만 제한한다.

## 모델과 cache

- FinCast와 Chronos‑2는 각각 manifest에 고정된 model/source revision만 로드한다.
- cache는 worker별 read-only volume으로 mount하며 image에 model weight를 포함하지 않는다.
- cache, revision, CUDA capability 또는 provenance가 맞지 않으면 worker는 시작 또는 요청을 fail-closed한다.
- 자동 download, 다른 모델로의 fallback, 임의 예측은 허용하지 않는다.

## 계약

요청과 응답의 `schema_version`은 `scalping-ai/v2`다. 지원 mode는 `forecast`와 `evaluate`이며 요청 크기, in-flight 수, timeout과 response 크기를 제한한다. 서버는 입력 bar의 시간 순서·완결성·고유 instrument key와 응답 model identity를 다시 검증한다.

시뮬레이션 API는 사용자가 lane을 고르지 않는다. `ai-paper-simulation/v9` 서버가 case별 `resolvedModelPlan`을 만들고 FinCast·Chronos‑2를 호출한다. 모델 결과가 stale/unavailable이거나 origin이 Rust 근거와 다르면 forward 판단을 cash로 닫는다.

## 검증

```bash
npm run test:ai-websocket
node scripts/verify-ai-compose-profiles.mjs
uv run --project worker/ai pytest worker/ai/tests
```

운영 전에는 health, model revision, CUDA device, token file 권한과 한 번의 결정적 round-trip을 확인한다. token이나 model cache 내용은 로그·문서·artifact에 저장하지 않는다.
