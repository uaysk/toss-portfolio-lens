# P40 AI qualification

현재 qualification lane은 FinCast와 Chronos‑2다. 두 모델은 같은 causal input, origin, horizon, 비용과 fill barrier로 비교하며 결과에는 model/source revision, input digest, precision, latency, VRAM과 정량 지표를 기록한다.

과거 모델로 생성된 `docs/reports/ai-p40-qualification-*`와 `public/reports/crypto-scalping-model-comparison.html`은 당시 결과를 재현하기 위한 역사 자료다. 이 파일은 현재 worker를 시작하거나 resume하는 입력으로 사용하지 않는다.

## 실행 원칙

- manifest에 고정된 cache와 revision만 사용한다.
- FinCast와 Chronos‑2 worker는 별도 container, token, endpoint와 artifact lane을 사용한다.
- `scalping-ai/v2` 이외의 요청·응답은 거부한다.
- 입력 digest와 origin이 다르거나 CUDA/precision 검증이 실패하면 비교 결과를 확정하지 않는다.
- checkpoint와 marker가 있는 장기 run은 live 상태를 확인한 뒤 resume하며 완료 단계를 다시 실행하지 않는다.

## 로컬 dashboard

`.env`의 PostgreSQL과 필수 인증 설정을 사용한다.

```bash
AI_QUALIFICATION_RUN_ROOT=/absolute/path/to/run npm run dev
```

별도 launcher를 사용할 때도 runtime directory는 로그와 marker에만 쓰며 database 파일을 만들지 않는다.

## 검증

```bash
uv run --project worker/ai pytest worker/ai/tests
npm run test:ai-websocket
npm run qualification:chronos2:tools
```

summary의 input/record digest, model identity, non-finite count, quantile monotonicity, latency와 peak VRAM을 확인한다. credential 원문과 model weight는 보고서에 포함하지 않는다.
