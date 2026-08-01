# GitLab CI 운영

이 저장소의 canonical Git remote는 `https://gitlab.uaysk.com/uaysk/toss-portfolio-lens`다. 기존 GitHub
remote는 이전 검증과 긴급 rollback을 위해 `github`라는 이름으로 보존한다.

## Pipeline 범위

`.gitlab-ci.yml`은 merge request, branch, tag에 대해 다음 gate를 실행한다.

- runner build container의 5 GiB hard limit, Docker socket·GPU device 미노출 preflight
- Node 정책·계약·TypeScript·production client/server build와 bundle budget
- OOM-safe Vitest light/heavy/PGlite lane
- Rust fmt, clippy, test, release binary와 indicator benchmark
- PostgreSQL 17 임시 service에서 migration, locking, durable queue와 Rust worker 통합
- fixture 기반 Playwright UI 회귀
- CNPG backup retention Go test와 정적 binary build
- 보호된 기본 브랜치에서 web/Rust 이미지의 Harbor publish, Trivy gate와 production 배포

FinCast, Chronos-2, TiRex-2, CUDA/GPU qualification, 모델 다운로드, live market/provider 검증은 일반 CI에서
실행하지 않는다. 운영 PostgreSQL, Harbor credential, Toss credential과 production Docker socket도 test
runner에 제공하지 않는다.

## Runner 경계

모든 job은 project-scoped Docker runner의 `toss-portfolio-lens-docker` tag를 요구한다. Runner는 다음
조건으로 유지한다.

- `privileged=false`, Docker socket mount 없음, project에 lock
- runner concurrency 1, build container memory/swap 5 GiB, service container memory/swap 768 MiB
- 전용 systemd slice의 `MemoryHigh` 5.5 GiB, `MemoryMax` 6 GiB로 호스트 전체 OOM을 차단
- Vitest light만 batch 2개까지 실행하고 heavy/PGlite는 file worker 1개
- 메모리 사용량이 큰 job은 `toss-portfolio-lens-memory-heavy` resource group으로 직렬화
- CI job image와 PostgreSQL service image는 manifest digest로 고정

GitLab CI cache에는 npm download cache, 서로 일치하는 TypeScript build info·declaration output과 Cargo cache만
저장한다. credential, `.env`, database dump, production release manifest는 cache나 artifact로 올리지 않는다.

## 이미지와 배포

일반 CI runner에서 privileged Docker-in-Docker나 host Docker socket을 사용하지 않는다. 모든 선행 stage가
성공한 보호된 기본 브랜치 pipeline만 별도 project-scoped shell runner의
`toss-portfolio-lens-release` tag로 이동한다. 이 runner는 `ref_protected`, project lock, concurrency 1이며
전용 Harbor project robot credential만 사용한다. Docker 접근 권한은 전용 systemd service의
`SupplementaryGroups=docker`에만 부여하고 test runner에는 전달하지 않는다.

Harbor robot은 `toss-portfolio-lens` namespace에서만 `repository:pull/push`, `artifact:read/list`,
`scan:create/read`, `artifact-addition:read`를 가진다. 마지막 권한은 Trivy vulnerability report 본문을
읽는 데 필요하며, project 관리·robot 관리·artifact 삭제·다른 namespace 접근은 허용하지 않는다.

1. source gate와 runtime module smoke
2. web 이미지와 변경된 경우에만 Rust 이미지를 순차적으로 4 GiB build limit 안에서 생성
3. immutable `git-$CI_COMMIT_SHA` tag push와 local OCI revision 확인
4. Harbor가 반환한 manifest digest로 후보 release 생성
5. 후보 web/Rust digest 모두 Harbor Trivy 재검사, fixable Critical/High 0건 확인
6. digest-pinned web/Rust 서비스만 재기동하고 container/local/public health 검증
7. 성공 시 current release 승격, 실패 시 직전 digest·Compose snapshot으로 자동 rollback

릴리스 job은 `toss-portfolio-lens-production` resource group과 호스트 `flock`을 함께 사용하고 retry를
비활성화한다. 따라서 같은 host에서 두 production release가 겹치지 않는다. build는 테스트 stage가 모두
끝난 뒤 순차 실행하고 시작 시 `MemAvailable` 3 GiB 미만이면 OOM 위험을 감수하지 않고 실패한다.

FinCast, Chronos-2, TiRex-2와 GPU runtime은 이 job의 build, pull, restart 대상이 아니다. Compose에서도
오직 `web`과 `compute-ipc` service만 명시적으로 조작한다.

릴리스 상태는 runner checkout이 아니라 `/var/lib/toss-portfolio-lens-release`에 mode 600으로 저장한다.
GitLab artifact에는 credential이나 production env가 아닌 digest candidate, build metadata, 정제된 Trivy
결과와 deployment report만 developer 이상에게 90일간 공개한다.

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

## Rollback

배포 health gate가 실패하면 job이 직전 `rollback.env`와 해당 Git SHA의 Compose snapshot을 적용하고
로컬·공개 health를 다시 확인한다. rollback이 성공해도 실패한 후보 pipeline은 red 상태로 남는다.

GitLab 장애 시 로컬 `github` remote를 다시 `origin`으로 바꾸고 기존 GitHub branch를 사용할 수 있다.
Release runner를 폐기할 때는 GitLab project runner와 Harbor robot을 먼저 revoke하고 전용 service/config,
Docker config를 제거한다. 운영 Compose, release state와 PostgreSQL 데이터는 별도 승인 없이 삭제하지 않는다.
