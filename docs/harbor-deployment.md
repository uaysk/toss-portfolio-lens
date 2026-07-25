# Harbor 기반 이미지 배포

운영 이미지의 source of truth는 비공개
`harbor.uaysk.com/toss-portfolio-lens` 프로젝트다. publish 단계에서는 전체 Git SHA 태그를 사용할 수 있지만,
배포와 rollback 입력에는 반드시 registry가 반환한 `repository@sha256:<manifest-digest>`를 사용한다.
`latest`나 변경 가능한 태그를 운영 배포에 사용하지 않는다.

로컬 개발의 `docker compose up --build` 흐름은 그대로 유지한다. 운영에서는 Harbor override가 `build:`를
제거하므로 소스 checkout에서 암묵적으로 이미지를 다시 만들 수 없다. 운영 호스트의 Compose가
`!reset` custom tag를 지원하는지 `docker compose config`로 먼저 확인한다.

이미지를 build할 때 `APP_GIT_SHA`에 전체 Git SHA를 전달한다. 모든 runtime image는 이 값을
`org.opencontainers.image.revision` OCI label로 보존한다. push 결과의 manifest digest를 release 파일에
기록한 뒤 digest를 pull하고 label이 `APP_GIT_SHA`와 일치하는지 검사한다.

## Main host release

Git에 넣지 않는 `.env.harbor.release`에 현재 release set을 저장한다.

```dotenv
APP_GIT_SHA=<full-40-character-git-sha>
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

## GPU worker release

Kronos와 FinCast는 서로 다른 저장소, digest, token과 프로세스를 유지한다. 모델 cache와 safetensors는
이미지에 포함하지 않으며 GPU 호스트의 검증된 read-only cache를 계속 mount한다.

Kronos 배포에는 `compose.harbor-kronos.yaml`, FinCast 배포에는
`compose.harbor-fincast.yaml`을 기존 GPU/remote overlay 뒤에 추가한다. 각각
`AI_WORKER_IMAGE`와 `AI_FINCAST_WORKER_IMAGE`를 Harbor digest로 설정하고 명시적으로 `pull`한 뒤
`up -d --no-build --pull never`를 사용한다. registry 여유 공간과 GPU worker preflight를 확인하기 전에는
대형 worker 이미지를 publish하거나 기존 worker를 교체하지 않는다.

Kronos의 canonical pull-only 명령은 다음과 같다.

```bash
docker compose \
  -f compose.yaml \
  -f compose.ai-gpu.yaml \
  -f compose.ai-remote-worker.yaml \
  -f compose.harbor-kronos.yaml \
  pull ai-worker

docker compose \
  -f compose.yaml \
  -f compose.ai-gpu.yaml \
  -f compose.ai-remote-worker.yaml \
  -f compose.harbor-kronos.yaml \
  up -d --no-build --pull never --no-deps ai-worker
```

FinCast는 위 파일 목록 뒤에 `compose.ai-remote-fincast.yaml`과
`compose.harbor-fincast.yaml`을 순서대로 추가하고 `--profile fincast`로 `fincast-worker`만 pull·기동한다.

## Local cache cleanup

운영 및 rollback digest의 원격 pull을 검증한 뒤에만 다음 정리를 수행한다.

```bash
docker image prune -a -f
docker builder prune -a -f
```

실행 중인 컨테이너가 참조하는 레이어는 로컬에 남는 것이 정상이다. 데이터 volume은 이미지 cache가 아니므로
중지 컨테이너도 이미지를 고정하므로 먼저 `docker ps -a`로 확인하고, 정확히 식별한 폐기 가능한 컨테이너만
별도 승인 아래 제거한다. `docker buildx ls`로 다른 builder가 없는지도 확인한다. 데이터 volume에는
`docker system prune --volumes`, `docker volume prune`, `docker compose down -v`를 사용하지 않는다.
