# Harbor 기반 이미지 배포

운영 이미지의 source of truth는 비공개
`harbor.uaysk.com/toss-portfolio-lens` 프로젝트다. publish 단계에서는 전체 Git SHA 태그를 사용할 수 있지만,
배포와 rollback 입력에는 반드시 registry가 반환한 `repository@sha256:<manifest-digest>`를 사용한다.
`latest`나 변경 가능한 태그를 운영 배포에 사용하지 않는다.

로컬 개발의 `docker compose up --build` 흐름은 그대로 유지한다. 운영에서는 Harbor override가 `build:`를
제거하므로 소스 checkout에서 암묵적으로 이미지를 다시 만들 수 없다. 운영 호스트의 Compose가
`!reset` custom tag를 지원하는지 `docker compose config`로 먼저 확인한다.

이미지를 build할 때 해당 component의 전체 Git SHA를 `APP_GIT_SHA` build argument로 전달한다. 각 runtime
image는 이 값을 `org.opencontainers.image.revision` OCI label로 보존한다. release 파일의
`APP_GIT_SHA`는 web revision, `RUST_WORKER_GIT_SHA`는 Rust worker revision을 뜻한다. push 결과의 manifest
digest를 기록한 뒤 digest를 pull하고 각 label이 해당 component revision과 일치하는지 검사한다.

push 직후에는 Harbor의 Trivy adapter로 각 digest를 다시 스캔한다. 스캔 결과는 credential을 포함하지 않는
mode 600 JSON으로 `.cache/security/`에 저장한다. `verify:harbor-trivy`는 수정 가능한 Critical 또는 High
취약점이 있으면 nonzero로 종료한다. 이 gate가 실패하면 해당 release를 배포하지 않고 base image나 직접
dependency를 갱신한 뒤 새 Git SHA와 새 digest로 다시 build·push·scan한다.

```bash
npm run verify:harbor-trivy -- "$WEB_IMAGE" \
  --output .cache/security/harbor-trivy-web.json
npm run verify:harbor-trivy -- "$RUST_WORKER_IMAGE" \
  --output .cache/security/harbor-trivy-rust-worker.json
```

Trivy DB에 수정 버전이 없거나 애플리케이션에서 도달할 수 없는 항목을 예외 처리하려면 CVE, package,
installed/fixed version, 도달성 근거와 만료일을 release 보고서에 남긴다. 단순히 severity를 낮추거나
스캔을 생략해 배포 게이트를 통과시키지 않는다.

## Main host release

Git에 넣지 않는 `.env.harbor.release`에 현재 release set을 저장한다.

```dotenv
APP_GIT_SHA=<full-40-character-git-sha>
RUST_WORKER_GIT_SHA=<full-40-character-rust-worker-git-sha>
WEB_IMAGE=harbor.uaysk.com/toss-portfolio-lens/web@sha256:<manifest-digest>
RUST_WORKER_IMAGE=harbor.uaysk.com/toss-portfolio-lens/rust-worker@sha256:<manifest-digest>
```

입력과 pull 가능성을 먼저 검증하고, 현재 운영 overlay들과 함께 pull-only로 기동한다.

```bash
npm run verify:harbor-release -- .env.harbor.release

docker compose \
  --env-file .env \
  --env-file .env.scalping \
  --env-file .env.harbor.release \
  -f compose.yaml \
  -f compose.chatgpt.yaml \
  -f compose.ai-remote-main.yaml \
  -f compose.harbor-main.yaml \
  pull web compute-ipc

npm run verify:harbor-release -- .env.harbor.release --inspect-local

docker compose \
  --env-file .env \
  --env-file .env.scalping \
  --env-file .env.harbor.release \
  -f compose.yaml \
  -f compose.chatgpt.yaml \
  -f compose.ai-remote-main.yaml \
  -f compose.harbor-main.yaml \
  up -d --no-build --pull never web compute-ipc
```

`/api/health`, simulation status의 `paperOnly=true`와 `realOrder=false`, 컨테이너 health를 확인한 뒤에만
이 release set을 현재 운영본으로 간주한다. 직전 release는 별도 ignored env 파일에 digest set 전체를
보존한다. rollback은 그 파일로 같은 `pull`과 `up --no-build --pull never` 절차를 반복한다.

### Web-only release

UI처럼 web만 변경된 release는 현재 Rust digest와 `RUST_WORKER_GIT_SHA`를 candidate 파일에 그대로 보존한다.
현재 `.env.harbor.release`는 먼저 mode 600의 `.env.harbor.rollback`으로 복사하고, 새 web SHA와 digest를
`.env.harbor.candidate`에 기록한다. Trivy 검사와 release 검증을 통과한 뒤 web 이미지만 pull한다.

```bash
npm run verify:harbor-release -- .env.harbor.candidate

docker compose \
  --env-file .env \
  --env-file .env.scalping \
  --env-file .env.harbor.candidate \
  -f compose.yaml \
  -f compose.chatgpt.yaml \
  -f compose.ai-remote-main.yaml \
  -f compose.harbor-main.yaml \
  pull web

npm run verify:harbor-release -- .env.harbor.candidate --inspect-local

docker compose \
  --env-file .env \
  --env-file .env.scalping \
  --env-file .env.harbor.candidate \
  -f compose.yaml \
  -f compose.chatgpt.yaml \
  -f compose.ai-remote-main.yaml \
  -f compose.harbor-main.yaml \
  up -d --no-build --pull never --no-deps web
```

`--no-deps`를 생략하거나 `compute-ipc`를 target에 포함하면 Rust runtime을 함께 다룰 수 있으므로 web-only
배포에서는 금지한다. 로컬과 공개 `/api/health`의 `build.gitSha`, web container health와 UI smoke를 확인한
뒤 candidate를 `.env.harbor.release`로 승격한다. 실패하면 rollback 파일로 web만 `pull`하고 같은
`up -d --no-build --pull never --no-deps web` 명령을 실행한다.

## GPU worker release

FinCast와 Chronos‑2는 서로 다른 저장소, digest, token과 프로세스를 유지한다. 모델 cache와
safetensors는 이미지에 포함하지 않고 GPU 호스트의 검증된 read-only cache를 mount한다.

FinCast는 `compose.ai-remote-fincast.yaml`과 `compose.harbor-fincast.yaml`, Chronos‑2는
`compose.ai-remote-chronos2.yaml`과 `compose.harbor-chronos2.yaml`을 적용한다. 각각
`AI_FINCAST_WORKER_IMAGE`, `AI_CHRONOS2_WORKER_IMAGE`를 Harbor digest로 설정한 뒤 명시적으로
`pull`하고 `up -d --no-build --pull never`를 사용한다.

두 worker의 endpoint와 token은 공유하지 않는다. cache가 없거나 revision/hash가 다르면 자동
download나 다른 모델 fallback 없이 unavailable로 닫혀야 한다.

GPU worker 이미지도 push한 digest별로 같은 Trivy 검사를 수행한다. 모델 cache와 weights는 이미지 밖의
read-only mount이므로 이미지 취약점 보고서와 별도로 checksum을 검증한다. GPU가 다른 검증 작업에
할당된 동안에는 worker 이미지를 publish할 수 있어도 running container를 재시작하지 않는다.

## Local cache retention and bounded cleanup

반복 release build가 CUDA·Python·Rust 의존성을 다시 내려받지 않도록 운영 호스트와 GPU worker는 저장소별
최신 release image를 최소 한 개 보존하고 최근 BuildKit cache도 유지한다. routine cleanup에서
`docker image prune -a -f`와 `docker builder prune -a -f`를 사용하지 않는다. 특히 `builder prune -a`는
`uv` download cache를 포함한 재사용 가능한 build cache까지 제거할 수 있다.

정리는 디스크 압박이 실제로 확인된 경우에만 수행한다. 먼저 `docker system df`, `docker buildx du`와
`docker ps -a`를 확인하고, 현재 release의 `git-<full-sha>` tag가 web, Rust, FinCast, Chronos‑2 각 저장소에
남아 있는지 검증한다. 그 뒤에도 정리가 필요하면 tagged latest release를 보존하는 기본 image prune과
30일보다 오래된 builder cache만 대상으로 하는 제한 명령을 사용한다.

```bash
docker image prune -f --filter "until=720h"
docker buildx prune -f --filter "until=720h" --reserved-space 20GB
```

`--reserved-space` 값은 호스트 여유 공간에 맞게 늘릴 수 있지만 줄이기 전에 다음 release 한 번을 cold build할
수 있는 공간을 별도로 확인한다. 명시적 `-a` 정리는 사용자가 해당 호스트의 cold-build 비용을 이해하고
별도로 승인한 경우에만 허용한다.

실행 중인 컨테이너가 참조하는 레이어는 로컬에 남는 것이 정상이다. 중지 컨테이너도 이미지를 고정하므로
정확히 식별한 폐기 가능한 컨테이너만 별도 승인 아래 제거한다. `docker buildx ls`로 다른 builder가
없는지도 확인한다. 데이터 volume은 이미지 cache가 아니므로 `docker system prune --volumes`,
`docker volume prune`, `docker compose down -v`를 사용하지 않는다.
