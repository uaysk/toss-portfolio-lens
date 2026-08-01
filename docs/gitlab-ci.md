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

GitLab CI cache에는 npm download cache, TypeScript build info와 Cargo cache만 저장한다. credential, `.env`,
database dump, production release manifest는 cache나 artifact로 올리지 않는다.

## 이미지와 배포

일반 CI runner에서 privileged Docker-in-Docker나 host Docker socket을 사용하지 않는다. Web/Rust Harbor
publish와 digest-pinned production 배포는 현재 `docs/harbor-deployment.md`의 검증된 운영 절차를 유지한다.
향후 CI packaging을 추가할 때는 별도 protected runner 또는 제한된 remote builder를 사용하고 다음 gate를
모두 통과해야 한다.

1. source gate와 runtime module smoke
2. immutable `git-$CI_COMMIT_SHA` image push
3. remote OCI revision 확인
4. Harbor Trivy의 fixable Critical/High 0건
5. digest release manifest 생성과 보호된 수동 배포

## Rollback

GitLab 장애 시 로컬 `github` remote를 다시 `origin`으로 바꾸고 기존 GitHub branch를 사용할 수 있다.
GitLab CI runner는 project runner를 pause/revoke한 뒤 전용 service/config만 중지하며, 운영 Compose와
PostgreSQL 데이터는 변경하지 않는다.
