# GitLab CI 운영

이 저장소의 canonical Git remote는 `https://gitlab.uaysk.com/uaysk/toss-portfolio-lens`다. 기존 GitHub
remote는 이전 검증과 긴급 rollback을 위해 `github`라는 이름으로 보존한다.

## Pipeline 범위

실행 시간·메모리·I/O·artifact 보존량을 측정하고 다른 저장소에도 재사용할 수 있는 최적화 절차는
[CI 파이프라인 최적화 가이드](ci-optimization.md)에 기록한다.

`.gitlab-ci.yml`은 merge request, branch, tag에 대해 다음 gate를 실행한다.

- runner build container의 5 GiB hard limit, Docker socket·GPU device 미노출 preflight
- Node 정책·계약·TypeScript·production client/server build와 bundle budget
- OOM-safe Vitest light/heavy/PGlite lane
- Rust fmt, clippy, test, release binary와 indicator benchmark
- PostgreSQL 17 임시 service에서 migration, locking, durable queue와 Rust worker 통합
- fixture 기반 Playwright UI 회귀
- CNPG backup retention Go test와 정적 binary build
- 보호된 기본 브랜치에서 전용 runner의 독립 release preflight를 거친 web/Rust Harbor publish,
  Trivy gate와 production 배포
- Vitest batch별 JUnit report와 MR/예약 pipeline의 OOM-safe light-suite Cobertura coverage
- GitLab Semgrep SAST와 pipeline secret detection, High/Critical SAST·모든 secret의 fail-closed gate

FinCast, Chronos-2, TiRex-2, CUDA/GPU qualification, 모델 다운로드, live market/provider 검증은 일반 CI에서
실행하지 않는다. 운영 PostgreSQL, Harbor credential, Toss credential과 production Docker socket도 test
runner에 제공하지 않는다.

`main`은 직접 push를 허용하지 않고 merge request로만 변경한다. pipeline 성공과 모든 discussion 해결을
병합 조건으로 사용한다. Free tier의 approval은 선택적이므로 유료 tier 도입 전까지 이 두 조건과 보호
브랜치를 최소 review boundary로 사용한다.

Vitest JUnit 파일은 lane·batch마다 분리해 `.cache/test-reports/`에 기록한다. coverage는 일반 branch
pipeline에서 중복 수집하지 않고 merge request와 scheduled pipeline에서만 light lane을 worker 1개로
재실행한다. batch별 V8 JSON을 한 coverage map으로 병합한 단일 Cobertura report와 전체 coverage 비율을
GitLab MR에 게시한다.

SAST와 secret detection은 GitLab의 pinned instance template을 사용한다. Free tier에서는 JSON report를
다운로드할 수 있지만 vulnerability management UI가 제한되므로 `security-report-gate`가 report 존재 여부를
fail-closed로 확인하고 High/Critical SAST 또는 secret 1건 이상이면 integration stage를 실패시킨다.
GitLab template이 선택하는 Semgrep 6과 Secrets 7 analyzer는 mutable major tag에 의존하지 않도록 CI job과
runner allowlist 모두 검증한 OCI index digest로 고정한다.

## Runner 경계

일반 build/test job은 project-scoped Docker runner의 `toss-portfolio-lens-docker` tag를 요구한다. Runner는
다음 조건으로 유지한다.

- `privileged=false`, Docker socket mount 없음, project에 lock
- runner concurrency 1, build container memory/swap 5 GiB, service container memory/swap 768 MiB
- 전용 systemd slice의 `MemoryHigh` 5.5 GiB, `MemoryMax` 6 GiB로 호스트 전체 OOM을 차단
- Vitest light만 batch 2개까지 실행하고 heavy/PGlite는 file worker 1개
- 메모리 사용량이 큰 job은 `toss-portfolio-lens-memory-heavy` resource group으로 직렬화
- CI job image와 PostgreSQL service image는 manifest digest로 고정

GitLab CI cache는 소유자를 분리한다. 모든 Node job은 npm download cache를 pull-only로 읽고 `node-static`만
같은 lockfile key에 push한다. TypeScript build info·declaration output·server build는 별도 build key로
`node-static`만 쓰며, `node_modules`는 cache하지 않는다. Cargo cache와 Rust target도 job별 목적을 유지하되
압축·복원 시간을 측정한 뒤 범위를 줄인다. credential, `.env`, database dump, production release manifest는
cache나 artifact로 올리지 않는다. 모든 job의 after-script는 credential 없이 cgroup memory peak/current,
CPU 사용량, I/O 합계와 memory event를 한 줄로 기록한다.

## 이미지와 배포

일반 CI runner에서 privileged Docker-in-Docker나 host Docker socket을 사용하지 않는다. 모든 선행 stage가
성공한 보호된 기본 브랜치 pipeline만 별도 project-scoped shell runner의
`toss-portfolio-lens-release` tag로 이동한다. 이 runner는 `ref_protected`, project lock, concurrency 1이며
전용 Harbor project robot credential만 사용한다. Docker 접근 권한은 전용 systemd service의
`SupplementaryGroups=docker`에만 부여하고 test runner에는 전달하지 않는다.

Release tag는 GitLab scheduling 경계이고 스크립트 내부 identity로 파싱하지 않는다.
[Job-only predefined variable](https://docs.gitlab.com/ci/variables/predefined_variables/)인
`CI_RUNNER_ID=14`와
`CI_RUNNER_DESCRIPTION=ubuntu-1-toss-portfolio-lens-release`가 모두 일치해야 한다. `DOCKER_CONFIG`는
GitLab project·job variable로 중복 선언하지 않고 전용 runner config와 systemd service가 제공하는
`/home/toss-portfolio-release/.docker`만 허용한다.

Harbor robot은 `toss-portfolio-lens` namespace에서만 `repository:pull/push`, `artifact:read/list`,
`scan:create/read`, `artifact-addition:read`를 가진다. 마지막 권한은 Trivy vulnerability report 본문을
읽는 데 필요하며, project 관리·robot 관리·artifact 삭제·다른 namespace 접근은 허용하지 않는다.

1. source·test·integration·security gate 통과
2. `release-preflight`가 runner identity, mode 600/700 경로, host memory, Docker daemon, canonical Buildx
   builder/worker, Harbor robot과 current manifest 검증
3. 실제 `release-production`이 같은 preflight를 다시 실행
4. web 이미지와 변경된 경우에만 Rust 이미지를 순차적으로 4 GiB build limit 안에서 생성
5. immutable `git-$CI_COMMIT_SHA` tag push와 local OCI revision 확인
6. Harbor가 반환한 manifest digest로 후보 release 생성
7. 후보 web/Rust digest 모두 Harbor Trivy 재검사, Critical/High 0건 확인
8. digest-pinned web/Rust 서비스만 재기동하고 container/local/public health 검증
9. 성공 시 current release 승격, 실패 시 직전 digest·Compose snapshot으로 자동 rollback

릴리스 job은 `toss-portfolio-lens-production` resource group과 호스트 `flock`을 함께 사용하고 retry를
비활성화한다. 따라서 같은 host에서 두 production release가 겹치지 않는다. build는 테스트 stage가 모두
끝난 뒤 순차 실행하고 시작 시 `MemAvailable` 3 GiB 미만이면 OOM 위험을 감수하지 않고 실패한다.

Docker daemon과 Buildx bootstrap probe는 2초 간격으로 최대 3회 재시도한다. 실패하면 credential이나 command
본문 대신 `stage=docker-info status=255` 형식의 고정 stage와 exit status를 남긴다. Buildx inspect 출력은
파이프로 조기 종료하지 않고 전부 수집한 뒤 driver와 worker status를 파싱한다. CI는
`toss-portfolio-lens-release` builder를 생성·삭제하지 않으며 `docker-container` driver와 running worker를
요구한다.

Chronos-2 qualification bundle은 `node-static`에서 임시 경로로 결정론적으로 다시 만들고 canonical
`qualification-tools/`와 byte·size·SHA-256을 비교한다. 검증이 끝난 generated output만 Semgrep 제외 경로로
취급하며, 원본 script와 검증기는 계속 SAST 대상이다. CNPG retention job은 schedule/default branch 또는
관련 경로 변경에서만 실행하고, test artifact는 소비자가 있는 진단 파일만 짧은 TTL로 보존한다.

FinCast, Chronos-2, TiRex-2와 GPU runtime은 이 job의 build, pull, restart 대상이 아니다. Compose에서도
오직 `web`과 `compute-ipc` service만 명시적으로 조작한다.

릴리스 상태는 runner checkout이 아니라 `/var/lib/toss-portfolio-lens-release`의 mode 700 directory와 mode
600 manifest에 저장한다. `release-preflight`와 실제 release는 schema
`toss-portfolio-release-preflight/v1`의 `.cache/release/preflight.json`을 각각 생성한다. 이 JSON에는 commit
SHA, runner ID, Docker/Buildx version, available memory와 단계별 성공 여부만 들어간다. GitLab artifact에는
credential이나 production env가 아닌 이 preflight, digest candidate, build metadata, 정제된 Trivy 결과와
deployment report만 developer 이상에게 90일간 공개한다.

ubuntu-1의 service 원본은
`infra/homelab/gitlab-runner-toss-portfolio-lens-release.service`, 등록용 local 설정은
`infra/homelab/gitlab-runner-release-config.template.toml`에 보존한다. 실제 `config.toml`의 runner token과
`/home/toss-portfolio-release/.docker/config.json`의 robot secret은 저장소에 넣지 않는다. host Node는
Volta가 관리하는 Node 22.14.0 binary를 `/opt/toss-portfolio-release/bin/node`에 고정 복사해 사용한다.
service는 `PrivateDevices=true`로 GPU device를 감추고 runner 프로세스 cgroup은 1.5 GiB로 제한한다.
Docker BuildKit 컨테이너는 별도로 4 GiB 제한을 받는다.

Docker socket은 root-equivalent 권한이므로 release service에만 `SupplementaryGroups=docker`를 부여한다.
production env와 MCP secret은 service의 `uaysk` supplementary group에만 읽기를 허용하고, 사용자 Harbor
admin config·SSH·glab config는 systemd `InaccessiblePaths`로 차단한다.

production deploy freeze 기간에는 `release-production`이 자동 실행되지 않고 blocking manual job으로
전환된다. 일반 protected-main push는 계속 자동 배포한다. 배포 성공 뒤 `publish-gitlab-release`가
`CI_JOB_TOKEN` 기반 glab auto-login으로 `production-<full-sha>` tag와 GitLab Release를 만들고 pipeline,
digest-pinned web/Rust image, rollback 기준을 release notes에 남긴다.

GitLab scheduled pipeline은 production 배포를 실행하지 않는다. nightly schedule은 전체 CPU/DB 회귀와
coverage·보안 report를 새 코드 변경과 독립적으로 갱신한다. release는 `CI_PIPELINE_SOURCE=push`인 보호된
기본 브랜치만 허용한다.

## Rollback

배포 health gate가 실패하면 job이 직전 `rollback.env`와 해당 Git SHA의 Compose snapshot을 적용하고
로컬·공개 health를 다시 확인한다. rollback이 성공해도 실패한 후보 pipeline은 red 상태로 남는다.

GitLab 장애 시 로컬 `github` remote를 다시 `origin`으로 바꾸고 기존 GitHub branch를 사용할 수 있다.
Release runner를 폐기할 때는 GitLab project runner와 Harbor robot을 먼저 revoke하고 전용 service/config,
Docker config를 제거한다. 운영 Compose, release state와 PostgreSQL 데이터는 별도 승인 없이 삭제하지 않는다.
