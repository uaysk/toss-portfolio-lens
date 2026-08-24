# CI 파이프라인 구성·최적화 운영서

이 문서는 Toss Portfolio Lens의 GitLab CI를 다른 저장소에도 이식할 수 있도록
구성 원칙, 기준선 측정, 최적화 절차와 안전한 롤백 기준을 정리한다. production
release의 보안·무결성 gate는 최적화 대상이 아니라 불변 조건이다.

실측값과 첫 번째·두 번째 개선을 카드, 비교 bar, timeline으로 탐색하려면
[단일 HTML+JS 시각 보고서](reports/ci-pipeline-optimization-report-2026-08-03.html)를 연다.

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

`.node-job`은 npm download cache만 `policy: pull`로 읽는다. 보호된 ref의 기본 브랜치·tag·schedule에서
실행되는 `node-static`만 `node-npm-v3`와 별도 `node-build-v3` cache를 `pull-push`하며, MR·feature와
비보호 tag·schedule의 같은 job은 pull-only다. 따라서 다섯 개의 test/integration consumer가 TypeScript
build output을 복원하거나 같은 cache를 다시 업로드하지 않고, 비보호 ref가 검증 cache를 덮어쓰지도 않는다.
`node_modules`는 cache/artifact로 저장하지 않는다.

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

### 검증된 client bundle 재사용

`node-static`이 만든 `dist/client`를 `ui-regression`의 명시적 `needs:artifacts` 입력으로 사용한다. 현재
production client build는 8.00초, peak RSS 677,240KB였고 전달 artifact는 556,200 bytes이므로, 작은
전송으로 UI lane의 두 번째 Vite compilation과 약 661MiB peak를 제거한다. 두 job은 같은 code-sensitive
rules를 사용해 producer 없이 consumer만 실행되는 조합을 막고, UI job은 `dist/client/index.html` 존재를
fail-closed로 확인한다.

Python AI worker는 별도 job에서 lock 기반 all-extras 환경을 CPU PyTorch backend로 한 번 설치한 뒤 Ruff와
250개 Pytest를 `--no-sync`로 실행한다. GPU lock의 수 GiB CUDA wheel은 일반 CI에 설치하지 않으며, 해당
job도 memory-heavy resource group으로 직렬화한다.

### 불필요한 checkout·작은 artifact·변경 경로

- repository 파일을 읽지 않는 `runner-boundary`에는 `GIT_STRATEGY: none`을 적용했다.
- `cnpg-backup-retention`은 protected main/schedule에서는 항상 실행하고, 그 외에는
  해당 디렉터리 또는 `.gitlab-ci.yml` 변경일 때만 실행한다.
- downstream consumer가 없는 CNPG binary artifact는 제거했다.
- 일반 test/diagnostic artifact TTL은 14일, UI는 7일, Rust integration binary는
  7일로 줄였고 release/security audit artifact는 90일을 유지했다.

## 4. 적용한 2차 최적화

2026-08-02에 첫 slice의 계측 결과를 바탕으로 다음 변경을 적용했다. 각 항목은
독립적으로 되돌릴 수 있고, protected main·schedule은 계속 full gate를 사용한다.

### 변경 경로와 artifact DAG

- `docs/**/*`, Markdown, LICENSE만 바뀐 MR/branch에는 `docs-validation`만 실행한다.
  코드·설정 변경이 하나라도 포함되면 node static, Vitest, Semgrep, Secret Detection,
  Rust, UI, PostgreSQL gate가 다시 열린다. default branch, tag, schedule은 항상
  complete validation boundary다.
- predecessor artifact가 필요 없는 job에는 `dependencies: []`를 명시했다. Rust binary가
  필요한 PostgreSQL job과 security report가 필요한 security gate만 `needs:artifacts`를
  유지한다. #67 trace에서 제거 가능한 artifact 다운로드는 10.6초였다.
- Vitest light lane과 coverage lane은 같은 JUnit 결과를 남기며, coverage job은 MR의
  code path 또는 schedule에서만 실행한다. 따라서 동일 light 테스트를 두 번 실행하는
  일반 branch 중복을 피하면서 MR coverage는 보존한다.

### 정확한 resource telemetry

공통 `after_script`를 제거하고 각 job의 `before_script`에서 `EXIT` trap을 설치했다.
로그에는 `scope=job-script`, job/runner ID, 종료 status, cgroup `memory.peak`,
`memory.current`, `memory.events`, CPU usage, I/O bytes만 출력한다. GitLab runner의
get-sources/cache 구간은 포함하지 않는다는 범위를 명시하므로, 이를 전체 job peak로
해석하지 않는다. credential, 환경변수 값, Docker config 내용은 출력하지 않는다.

### PGlite 메모리 인지 스케줄러와 fixture 재사용

`run-vitest-batches.mjs`는 PGlite child 하나에 1,536 MiB를 예약하고 512 MiB headroom을
제외한 뒤 `VITEST_PGLITE_MAX_PARALLEL`을 clamp한다. CI는 최대 2개 process를 실행하며
`server/services/run-service.test.ts`는 단독으로 둔다. 각 batch는 여전히 Vitest
worker 1개와 file parallelism off를 유지한다. RunService, ScalpingRepository,
TechnicalAnalysisService fixture는 비싼 PGlite process를 file당 하나만 만들고
`DROP SCHEMA ... CASCADE` reset으로 test 간 격리를 회복한다. 한 테스트에서 두 독립
database가 동시에 필요한 checkpoint fixture는 기존 per-test 수명을 유지한다.

실제 로컬 검증(HTTP test를 허용한 runner, 2026-08-02):

| 지표 | 기존 #67 PGlite | 새 scheduler | 변화 |
|---|---:|---:|---:|
| 22 batch elapsed | 258.7초 | 130.5초 | 128.2초/49.6% 감소 |
| peak aggregate child RSS | 2.86 GiB | 2.30 GiB | 0.56 GiB 감소 |
| 결과 | 22/22 성공 | 22/22 성공 | OOM 0 |

새 pipeline에서도 job trace의 peak와 `memory.events`를 확인한 뒤 2-way 설정을
승격한다. 4 GiB job envelope에서 peak가 3.75 GiB를 넘거나 OOM이 발생하면
`VITEST_PGLITE_MAX_PARALLEL=1`로 즉시 rollback한다.

### UI, Rust, Semgrep, release disk guard

- UI regression 성공 시 PNG screenshot을 삭제하고 `report.json`·실패 시 screenshot만
  artifact로 보존한다. #67 UI archive 4.4 MB 중 약 99.8%가 성공 PNG였으므로, 성공
  artifact는 약 10 KB 수준으로 줄어든다. shell이 실패하면 삭제 단계에 도달하지 않아
  debugging evidence가 보존된다.
- Rust는 registry/git과 `target` cache를 별도 key로 분리하고, MR/feature에서는
  `policy: pull`, protected default branch/tag/schedule에서만 `pull-push` writer를 사용한다.
  `CARGO_INCREMENTAL=0`으로 branch마다 누적 incremental object를 만들지 않는다.
  lockfile은 두 key 모두에 포함한다.
- Semgrep analyzer에는 `SAST_SCANNER_ALLOWED_CLI_OPTS=--timeout 5`를 적용한다.
  복잡한 test/tool 파일에서 더 긴 rule timeout을 주면 runner wall time이 급증하므로
  analyzer default budget을 유지한다. local/ephemeral URL false positive는 근거가 있는
  좁은 `nosemgrep` 주석으로 차단한다.
  security gate는 report의 vulnerabilities뿐 아니라, report에 scan metadata가 있을
  때 `status`, errors, timeout event를 확인한다. Secret Detection도 metadata가
  실패하면 통과시키지 않는다. 기존 metadata 없는 unit fixture는 호환성을 유지한다.
- release preflight는 source checkout과 Docker root 각각 15 GiB 이상의 free disk를
  확인하고 `docker_root_directory`와 available KiB를 credential 없이 preflight JSON에
  기록한다. 공유 host에서 `docker system prune`를 자동 실행하지 않는다. threshold
  미달 시 cleanup 대상과 release lock 상태를 운영자가 확인한 뒤 재시도한다.

### Production 런타임 이미지 축소

2026-08-24 로컬 후보 빌드에서는 official Node builder의 실행 파일을 별도 stage에서
복사하던 구조를 제거하고, digest-pinned Alpine runtime에 `nodejs`, `libstdc++`,
`icu-data-full`, `ca-certificates`만 설치했다. 저장소 패키지 버전이 이동할 수 있으므로
빌드 중 Node major가 22인지 fail-closed하게 검사하고, runtime stage에서 production
dependency 전체 import smoke를 통과해야만 최종 이미지를 만들도록 했다. 전체 ICU를
유지해 `ko-KR`, `en-CA`, `en-US` locale과 서울 시간대 포맷도 확인했다.

| 로컬 이미지 | 압축 전 image size | 비교 |
|---|---:|---:|
| 이전 official Node 복사 후보 | 143,266,498 bytes | 기준 |
| Alpine `nodejs` 후보 | 126,909,569 bytes | 16,356,929 bytes/11.42% 감소 |
| 현재 Harbor production | 160,927,293 bytes | 후보가 34,017,724 bytes/21.14% 작음 |

후보 이미지는 UID 10001 non-root, Node 22.23.2, production module import와 locale
smoke를 통과했다. 이 값은 로컬 측정이며 배포 완료를 뜻하지 않는다. release 승격 시에는
기존과 동일하게 immutable SHA, Trivy Critical/High 0, health SHA와 rollback gate를
통과한 실제 registry digest 크기를 다시 기록한다.

### 실제 최적화 pipeline 검증

커밋 `6f00b25`의 pipeline #77은 2026-08-02에 동일한 runner #13에서 전체 성공했다.
기준선 #67과의 비교는 다음과 같다. #77의 전체 wall-clock은 runner가
`concurrent=1`인 상태에서 CNPG job이 248.1초 대기하고, 새 Rust cache key가 첫
writer를 아직 거치지 않아 cold compile을 수행한 영향을 받았다. 따라서 queue를 줄이는 것은 별도의
runner 용량 실험으로 남기고, 이 표에서는 workload·메모리·저장공간 효과를 분리해
판정한다.

| 지표 | 기준선 #67 | 최적화 #77 | 변화 |
|---|---:|---:|---:|
| 전체 wall-clock | 929.3초 | 1,010.8초 | +81.5초 (queue/cold 영향) |
| job duration 합계 | 903.6초 | 988.1초 | +84.5초 (Rust cold 영향) |
| queue duration 합계 | 89.5초 | 431.5초 | runner 직렬화 병목 |
| 압축 artifact 합계 | 6,418,431 bytes | 2,005,288 bytes | 4,413,143 bytes/68.8% 감소 |
| `vitest-pglite` job | 277.4초 | 151.4초 | 125.9초/45.4% 감소 |
| PGlite report execution | 258.8초 | 133.7초 | 125.1초/48.3% 감소 |
| PGlite peak aggregate child RSS | 2,927,951,872 bytes | 2,206,564,352 bytes | 24.6% 감소 |
| `ui-regression` artifact | 4,409,064 bytes | 1,096 bytes | 99.98% 감소 |

PGlite는 22/22 batch 성공, `OOM=0`이고, 새 resource trap도
`memory_peak_bytes=2471448576`, `memory_events=low 0,high 0,max 0,oom 0,oom_kill 0`을
기록했다. Rust는 #77에서 225.5초에 186개 lib와 10개 main 테스트를 통과했으며, 이는
분리된 `rust-*-v2` cache를 아직 protected default branch writer가 채우기 전의 첫 cold
consumer 비용이다. protected default branch의 `pull-push` 실행으로 cache를 채운 뒤
다음 warm run에서 compile 시간을 다시 측정해야 한다. Semgrep은 `--timeout 5`에서
245.1초, scan status `success`, timeout/error 0,
High/Critical 0(전체 SAST 64건)이었다. 이전 실험의 `--timeout 15`는 348.3초까지
늘었으므로 5초 budget을 유지한다.

## 5. 안전한 최적화 순서

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

기존 Docker executor의 after-script cgroup 파일은 job shell scope(약 5 MiB)를 보고해
Vitest batch RSS와 일치하지 않았다. 새 trap도 `scope=job-script`로 범위를 명시하며
이를 전체 job memory로 해석하지 않는다. 실제 memory 판정은 각 Vitest batch의
`peak=...MiB`, OOM event와 runner boundary의 5 GiB limit을 사용한다.

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

## 6. 후속 실험과 인프라 의존 항목

다음 항목은 첫 slice와 분리해 측정한다.

- Rust target cache의 실제 compressed size와 warm compile 시간을 main writer에서
  재측정한다. warm Rust job이 기존 대비 5% 넘게 느려지거나 cache archive가 줄지
  않으면 `CARGO_INCREMENTAL=0` 또는 target cache split을 되돌린다.
- UI/Rust/PostgreSQL의 MR path gate는 dependency map과 false-negative test를 먼저
  작성한다. protected main과 schedule은 full gate를 유지한다.
- 추가 runner는 기존 6 GiB host의 `concurrent`만 올려서 해결하지 않는다. 별도
  memory envelope와 socket/GPU 경계를 가진 runner pool을 추가하고 나서만
  resource group을 분리한다. 목표는 2개 독립 runner에서 10~12분이다.
- remote sccache, registry BuildKit cache, digest-pinned Rust CI image는 access
  control·quota·lifecycle 설계를 먼저 확정한다.

## 7. 다른 저장소 적용 checklist

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

### 재사용 가능한 적용 순서

1. `.ci-code-paths`와 `.ci-doc-paths`를 저장소의 실제 build/test/security 경계로
   바꾸고, docs-only positive/negative case를 CI lint로 확인한다.
2. `dependencies: []`를 artifact graph와 대조해 적용한다. downstream input이 있는
   `needs:artifacts`는 제거하지 않는다.
3. 공통 resource trap의 출력 필드를 정하고, credential redaction test를 먼저 만든다.
4. memory reservation을 실제 peak RSS p95보다 크게 잡고, parallelism을 환경변수로
   clamp한다. 한 번에 한 fixture pool만 재사용하며 schema reset 후 원래 test count를
   비교한다.
5. 성공 artifact와 실패 artifact의 보존 요구를 분리한다. 성공 시 큰 screenshot/log를
   지우되 실패 경로에서는 삭제하지 않는다.
6. cache는 lockfile key, 명시적 writer, feature pull-only policy, TTL과 compressed
   size를 함께 기록한다. release/preflight와 보안 report는 90일 audit 보존을 유지한다.
7. GitLab CI Lint → unit/release-tool → cold/warm pipeline → protected main release
   순서로 승격하고, wall time뿐 아니라 queue, RSS, OOM, artifact bytes, finding
   fingerprint, rollback health를 같은 표로 남긴다.
