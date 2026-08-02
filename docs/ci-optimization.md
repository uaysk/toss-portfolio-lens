# CI 파이프라인 구성·최적화 운영서

이 문서는 Toss Portfolio Lens의 GitLab CI를 다른 저장소에도 이식할 수 있도록
구성 원칙, 기준선 측정, 최적화 절차와 안전한 롤백 기준을 정리한다. production
release의 보안·무결성 gate는 최적화 대상이 아니라 불변 조건이다.

## 1. 현재 파이프라인 경계

`.gitlab-ci.yml`의 단계는 `preflight → validate → test → integration →
release-preflight → release`다. 일반 job은 Docker socket과 GPU가 없는 5 GiB
runner에서 실행하고, production job만 별도 release runner로 이동한다.

불변 조건은 다음과 같다.

- protected default branch에서만 production release를 실행한다.
- test runner에는 production credential, Docker socket, GPU를 제공하지 않는다.
- Vitest는 light/heavy/PGlite lane과 cgroup/RSS 측정으로 OOM을 fail-closed하게 다룬다.
- release preflight를 독립 job과 실제 release job에서 각각 실행한다.
- immutable Git SHA image, digest-pinned deploy, Trivy Critical/High 0, health SHA,
  PostgreSQL storage, `rust_socket`, paper-only order boundary와 rollback을 유지한다.

## 2. pipeline #62 기준선

2026-08-02 main pipeline #62를 같은 runner/image 기준선으로 사용했다.

| 항목 | 관찰값 |
|---|---:|
| job 수 | 15 |
| wall-clock | 1,076.5초 (17분 56.5초) |
| job duration 합계 | 1,048.6초 |
| queue duration 합계 | 353.3초 |
| 압축 artifact 합계 | 9,080,780 bytes |
| 가장 긴 job | `vitest-pglite` 286.6초 |
| 두 번째 병목 | `semgrep-sast` 227.4초 |
| PGlite peak batch RSS | 2,859 MiB |
| OOM event | 0 |

Docker runner #13은 `concurrent=1` 경계 때문에 일반 job을 사실상 직렬화한다.
현재 wall-clock의 대부분은 artifact 전송보다 runner 점유와 PGlite/Semgrep 실행이다.
`cnpg-backup-retention`은 29.2초 실행에 230.3초를 대기했고, UI/CNPG/Rust
artifact가 성공 pipeline artifact의 98.4%를 차지했다.

기준선 수집 명령은 다음과 같다.

```bash
glab api 'projects/13/pipelines/<pipeline-id>/jobs?per_page=100'
glab api 'projects/13/jobs/<job-id>/trace'
jq '{group,memory,execution,batches}' .cache/performance/vitest-*.json
```

trace에는 각 job의 `ci-resource-metrics` line이 포함된다. 이 line은 cgroup
`memory.peak`, `memory.current`, `memory.events`, CPU usage와 I/O bytes만 기록하며
credential이나 환경변수 값을 출력하지 않는다.

## 3. 이번 최적화 slice

### 단일 cache writer

`.node-job`은 npm download cache만 `policy: pull`로 읽는다. `node-static`만
`node-npm-v2`와 별도 `node-build-v2` cache를 `pull-push`한다. 따라서 다섯 개의
test/integration consumer가 TypeScript build output을 복원하거나 같은 cache를
다시 업로드하지 않는다. `node_modules`는 cache/artifact로 저장하지 않는다.

새 cache key를 도입할 때는 lockfile을 key에 포함하고, writer를 한 job으로 명시한다.
cold cache와 lockfile 변경 cache를 각각 검증한다.

### 재현 가능한 generated bundle

`qualification-tools/`는 `scripts/`의 canonical TypeScript를 esbuild로 만든
generated output이다. `node-static`은 임시 디렉터리에
`npm run qualification:chronos2:tools`를 실행한 뒤
`scripts/verify-qualification-tools.mjs`로 tracked manifest, byte length, SHA-256과
byte-for-byte 결과를 비교한다. `scripts/verify-qualification-tools.test.mjs`는
한 byte를 바꾼 bundle을 거부하는 negative test도 수행한다.

재현성 gate가 통과한 뒤에만 `qualification-tools`를 `SAST_EXCLUDED_PATHS`에 둔다.
canonical TypeScript는 계속 Semgrep 대상이고, Secret Detection은 변경하지 않는다.

### 불필요한 checkout·작은 artifact·변경 경로

- repository 파일을 읽지 않는 `runner-boundary`에는 `GIT_STRATEGY: none`을 적용했다.
- `cnpg-backup-retention`은 protected main/schedule에서는 항상 실행하고, 그 외에는
  해당 디렉터리 또는 `.gitlab-ci.yml` 변경일 때만 실행한다.
- downstream consumer가 없는 CNPG binary artifact는 제거했다.
- 일반 test/diagnostic artifact TTL은 14일, UI는 7일, Rust integration binary는
  7일로 줄였고 release/security audit artifact는 90일을 유지했다.

## 4. 안전한 최적화 순서

### 실제 warm 검증 결과

같은 commit `78e70e5a2f962697b78df2bd84a1db0af27c9f86`에서 push pipeline #64(cold)와
수동 warm pipeline #65를 실행했다. branch pipeline은 release job을 실행하지 않으므로
`main` #62에서 release-preflight·release-production·publish를 제외한 non-release 구간과
비교했다.

| 지표 | main #62 non-release | #64 cold | #65 warm | 관찰 |
|---|---:|---:|---:|---|
| wall-clock | 986.5초 | 1,100.9초 | 960.4초 | warm 기준 26.2초/2.7% 단축 |
| job duration 합계 | 963.5초 | 1,075.1초 | 937.4초 | warm 기준 26.1초/2.7% 단축 |
| queue duration 합계 | 349.4초 | 134.0초 | 370.4초 | runner 직렬화와 시점 영향이 큼 |
| 압축 artifact | 9,072,068 bytes | 6,418,927 bytes | 6,418,361 bytes | 2,653,707 bytes/29.3% 감소 |
| `node-static` | 36.5초 | 84.3초 | 39.2초 | 새 cache cold 비용 후 기준선 근접 |
| `semgrep-sast` | 227.4초 | 265.0초 | 220.3초 | warm 7.0초/3.1% 단축 |
| `vitest-pglite` | 286.6초 | 302.3초 | 287.7초 | 유의미한 계산 개선 없음 |

warm run의 trace에서 `node-npm-v2`와 `node-build-v2`가 모두 hit했고, Vitest consumer는
`policy: pull` 때문에 cache를 upload하지 않았다. artifact 감소는 consumer가 없는 CNPG
binary(2,653,685 bytes) 제거로 설명되며, TTL 단축 효과는 보존 기간이 지나야
retained-byte-days로 측정한다. 따라서 이번 slice는 artifact/cache write와 warm non-release
makespan에서는 개선됐지만, PGlite 병목을 해결한 것으로 승격하지 않는다. PGlite batch-size,
추가 runner, Rust target 축소는 후속 실험으로 남긴다.

현재 Docker executor의 after-script cgroup 파일은 job shell scope(약 5 MiB)를 보고해
Vitest batch RSS와 일치하지 않았다. 이를 전체 job memory로 해석하지 않는다. 실제 memory
판정은 각 Vitest batch의 `peak=...MiB`, OOM event와 runner boundary의 5 GiB limit을
사용하며, 다음 단계에서 runner-level cgroup path 또는 process sampler를 별도로 검증한다.

두 pipeline 모두 Secret Detection은 0건이고 High/Critical SAST는 0건이었다. Semgrep의 전체
Medium finding 수는 analyzer timeout 변동으로 #62=44, #64=42, #65=45였으므로, 이를 성능
개선의 보안 동등성 증거로 사용하지 않는다. release 승격 전에는 동일 analyzer image에서
재현성 있는 fingerprint 비교를 별도 수행한다.

### 측정·승격 절차

1. 기준선 1회와 warm control 3~5회를 같은 runner/image에서 측정한다.
2. 하나의 가역적인 변경만 적용하고 GitLab CI Lint, unit/release-tool,
   security-report gate를 통과시킨다.
3. cold cache와 warm cache를 각각 한 번 이상 실행한다.
4. median, min/max, p95를 비교한다. 단일 성공 run을 개선으로 판정하지 않는다.
5. protected main에서는 release invariant를 한 번 검증한다.
6. 정확성·보안·OOM·release gate가 하나라도 회귀하면 속도 개선과 관계없이 즉시
   해당 slice를 rollback한다.

첫 slice의 promotion 기준은 다음과 같다.

- 5회 median non-release makespan이 4% 이상 감소한다.
- OOM/oom-kill, unexpected retry, test count/result 변화가 없다.
- canonical Semgrep/Secret findings가 동일하다.
- artifact retained-byte-days가 70% 이상 감소한다.
- coverage는 의도하지 않게 0.1 percentage point 이상 낮아지지 않는다.

## 5. 후속 실험과 인프라 의존 항목

다음 항목은 첫 slice와 분리해 측정한다.

- PGlite batch size 2 실험: worker 1개·file parallelism 없음은 유지하고, 10% 이상
  빨라지며 peak RSS 3.75 GiB 미만이고 RSS 증가 누수가 없을 때만 승격한다.
- `node-static` client bundle을 UI job에 전달하는 artifact/cache 실험: 전송 bytes와
  시간을 build 6~7초 절감분과 비교한다.
- Rust target cache 축소 또는 `CARGO_INCREMENTAL=0` 실험: cache archive 2 GiB와
  약 30초 저장 비용을 줄이되 warm Rust job 회귀 5% 이내일 때만 유지한다.
- UI/Rust/PostgreSQL의 MR path gate는 dependency map과 false-negative test를 먼저
  작성한다. protected main과 schedule은 full gate를 유지한다.
- 추가 runner는 기존 6 GiB host의 `concurrent`만 올려서 해결하지 않는다. 별도
  memory envelope와 socket/GPU 경계를 가진 runner pool을 추가하고 나서만
  resource group을 분리한다. 목표는 2개 독립 runner에서 10~12분이다.
- remote sccache, registry BuildKit cache, digest-pinned Rust CI image는 access
  control·quota·lifecycle 설계를 먼저 확정한다.

## 6. 다른 저장소 적용 checklist

- [ ] pipeline DAG와 protected release invariant를 먼저 적는다.
- [ ] runner별 memory/socket/GPU 경계와 실제 concurrency를 측정한다.
- [ ] job별 duration, queue, retry, cgroup peak/events, CPU/I/O를 수집한다.
- [ ] workload를 memory-exclusive, general, security, release lane으로 분류한다.
- [ ] cache key, writer, path, compressed size, TTL, consumer를 표로 만든다.
- [ ] generated code는 canonical source와 deterministic rebuild gate를 먼저 만든다.
- [ ] path gate는 main/schedule full-run 예외와 negative dependency test를 포함한다.
- [ ] artifact는 실패 분석에 필요한 최소 evidence만 남기고 성공 artifact TTL을 줄인다.
- [ ] 최적화마다 hypothesis, expected range, acceptance, rollback, owner를 기록한다.
- [ ] 최종 main run에서 immutable artifact, security gate, health와 rollback 기준을
  원래 값과 비교한다.
