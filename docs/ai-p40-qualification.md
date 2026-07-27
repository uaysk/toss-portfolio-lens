# Tesla P40 모델 자동 검증과 실시간 모니터링

이 러너는 Codex가 계속 연결되어 있지 않아도 다음 작업을 순차 실행한다.

1. Tesla P40 / CUDA compute capability 6.1 / 기존 Docker 이미지 / 모델 캐시 사전 점검
2. BTCUSDT, ETHUSDT 각각 48시간 입력으로 Kronos-Base + FinCast 기준선 리플레이
3. 같은 입력으로 Kronos `kv-cache-v1` 출력 동등성과 속도 검증
4. FinCast microbatch 4, 8, 16 지연시간과 반복 출력 안정성 측정
5. JSON 요약, Markdown 보고서, Codex 인계 프롬프트 생성

전체 실행 예산은 기본 6시간이다. 각 리플레이는 30분 경계마다 과거 512개 봉을 계속 참조하므로, 30분 조각이 서로 독립된 입력처럼 초기화되지 않는다. 이 실행은 48시간 screening이며 5주 최종 검증을 대체하지 않는다.

Docker image build와 배포는 전혀 수행하지 않는다. `docker-source` 모드는 기존 이미지의 Python 환경을 재사용하면서 현재 저장소의 `worker/ai/src`만 `/app/src`에 읽기 전용으로 연결한다.

## 사전 조건

- GPU 0이 `Tesla P40`, compute capability가 `6.1`이어야 한다.
- `nvidia-smi`, Docker와 NVIDIA Container Toolkit을 사용할 수 있어야 한다.
- Kronos와 FinCast의 기존 이미지가 로컬에 있어야 한다.
- 고정된 모델 파일이 들어 있는 Docker volume 또는 절대 호스트 경로가 있어야 한다.
- Node 의존성이 설치되어 있어야 한다.
- 리플레이 구간의 Binance 공개 1분봉을 조회할 수 있어야 한다.
- 기존 시뮬레이션은 GPU 충돌을 막기 위해 먼저 중단되어 있어야 한다.

기본 이미지 이름은 다음과 같다.

```text
toss-portfolio-lens-ai-worker:local
toss-portfolio-lens-fincast-worker:local
```

다른 기존 이미지를 쓸 때만 환경 변수로 지정한다. 태그나 digest는 이미 존재해야 하며 러너가 build 또는 pull하지 않는다.

```bash
export AI_WORKER_IMAGE='기존-Kronos-이미지'
export AI_FINCAST_WORKER_IMAGE='기존-FinCast-이미지'
```

기본 모델 캐시는 Compose 기본 project 이름을 기준으로
`toss-portfolio-lens_ai_model_cache`를 사용한다. 실제 이름은 다음 읽기 전용 명령으로 확인할 수 있다.

```bash
docker volume ls --filter label=com.docker.compose.volume=ai_model_cache
```

이름이 다르거나 절대 호스트 경로를 쓸 경우 설정한다.

```bash
export AI_MODEL_CACHE_SOURCE='실제-Kronos-cache-volume-또는-절대경로'
export AI_FINCAST_MODEL_CACHE_SOURCE='실제-FinCast-cache-volume-또는-절대경로'
```

## 웹 대시보드 시작

웹 서버와 러너가 같은 절대 실행 루트를 보게 해야 한다. 로컬 개발 서버는 다음처럼 시작한다.

```bash
cd /home/uaysk/toss-portfolio-lens
AI_QUALIFICATION_RUN_ROOT=/home/uaysk/toss-portfolio-lens/data/ai-qualification npm run dev:legacy
```

기존 프로젝트 환경 변수는 평소와 동일하게 제공해야 한다. 로그인 후 다음 화면을 연다.

```text
http://localhost:5173/#ai-qualification
```

대시보드는 인증된 읽기 전용 API만 사용한다. SSE 상태, 활성 단계 예상 진행률, 전체 진행률, 경과/잔여 예산, GPU 사용률, VRAM, 온도, 단계 결과와 이벤트를 1초 간격으로 갱신한다. SSE 연결이 끊기면 1초 HTTP polling으로 자동 전환한다.

운영 웹 컨테이너에서 보려면 러너의 실행 루트를 컨테이너에 읽기 전용으로 mount하고 `AI_QUALIFICATION_RUN_ROOT`를 그 컨테이너 경로로 설정해야 한다. 현재 작업은 Docker build나 `tpl.uaysk.com` 배포를 수행하지 않는다.

## 실행 전 계획만 확인

이 명령은 파일, 컨테이너, GPU 상태를 변경하지 않는다.

```bash
cd /home/uaysk/toss-portfolio-lens
npm run qualification:ai:p40 -- \
  --dry-run \
  --run-id p40-plan
```

## 실제 6시간 자동 실행

첫 터미널에서 대시보드 서버를 유지하고 두 번째 터미널 또는 `tmux` 세션에서 실행한다.

```bash
cd /home/uaysk/toss-portfolio-lens
npm run qualification:ai:p40 -- \
  --run-id p40-20260727-a \
  --run-root /home/uaysk/toss-portfolio-lens/data/ai-qualification \
  --budget-hours 6 \
  --duration-hours 48 \
  --symbols BTCUSDT,ETHUSDT \
  --worker-mode docker-source
```

`--end-exclusive`를 생략하면 실행 시점보다 61분 이전의 마지막 정확한 UTC 분을 자동 선택한다. 동일 시장 구간을 재현해야 할 때만 다음처럼 명시한다. 지정 시점은 실행 시점보다 최소 61분 이전이어야 한다.

```bash
--end-exclusive 2026-07-27T00:00:00Z
```

러너는 자신이 만든 고유 이름의 테스트 컨테이너만 정리한다. `Ctrl-C` 또는 `SIGTERM`을 받으면 현재 자식 프로세스를 중단하고 해당 컨테이너와 임시 인증 파일을 정리한 뒤 상태를 `cancelled`로 기록한다.

중단된 비종료 실행을 재개하려면 같은 실행 루트와 ID를 사용한다. 완료 단계는 건너뛴다.

```bash
npm run qualification:ai:p40 -- \
  --run-root /home/uaysk/toss-portfolio-lens/data/ai-qualification \
  --resume p40-20260727-a
```

## 완료 후 생성 파일

기본 실행 디렉터리는 다음과 같다.

```text
/home/uaysk/toss-portfolio-lens/data/ai-qualification/<run-id>/
```

Codex에 전달할 핵심 파일은 다음과 같다.

- `state.json`: 최종 상태, 예산, 단계별 성공/실패/소요시간
- `qualification-summary.json`: 동등성·안정성 gate와 속도 비교
- `qualification-report.md`: 사람이 읽는 결과 요약
- `codex-handoff-prompt.md`: 바로 복사할 분석 요청
- `replays/*.json`: 심볼·후보별 원본 리플레이 결과
- `benchmarks/*.json`: FinCast batch별 원본 지연시간
- `events.jsonl`: 시간순 진행 이벤트
- `logs/*.log`: 실패 원인과 명령 출력

최소한 다음 정보는 전달한다.

1. 실행 ID와 실행 디렉터리
2. `state.json`의 최종 `status`
3. `qualification-summary.json`, `qualification-report.md`
4. 실패 단계가 있으면 그 단계의 `logs/*.log`
5. 러너 실행 중 저장소 코드를 수정했는지 여부

## Codex에 전달할 프롬프트

각 실행이 끝나면 실행 디렉터리의 `codex-handoff-prompt.md`가 정확한 경로를 포함해 자동 생성된다. 직접 작성할 때는 아래 템플릿을 사용한다.

```text
다음 Tesla P40 AI 검증 실행 결과를 분석해줘.

- 실행 ID: <run-id>
- 실행 디렉터리: <절대 경로>
- 요약 JSON: <절대 경로>/qualification-summary.json
- 보고서: <절대 경로>/qualification-report.md
- 상태: <절대 경로>/state.json
- 이벤트: <절대 경로>/events.jsonl
- 로그: <절대 경로>/logs

요청:
1. state.json과 qualification-summary.json의 schema/status/gate를 확인하고, 실패·누락 단계가 있으면 해당 로그와 원본 JSON에서 원인을 찾아라.
2. Kronos base 대비 kv-cache-v1의 심볼별 speedup, record/context digest, 최대 지표 차이를 표로 비교하라.
3. FinCast batch 4/8/16의 median/p95, 출력 안정성, provenance, VRAM 위험을 비교하고 가장 안전한 후보를 제안하라.
4. 이 결과는 48시간 screening임을 명시하고, 채택 후보에 필요한 5주 out-of-sample 검증 계획과 예상 P40 시간을 갱신하라.
5. 최적화가 완전히 확정되기 전에는 Docker build나 배포를 하지 마라.
6. 추가 수정이 필요하면 코드 수정, 집중 테스트, dry-run까지만 진행하고 변경 파일과 검증 결과를 알려라.
```
