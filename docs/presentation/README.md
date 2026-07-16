# README presentation assets

이 디렉터리는 프로젝트 README에 넣을 실제 애플리케이션 화면과 아키텍처 슬라이드의 재현 가능한 원본을 관리합니다.

## 화면 데이터

애플리케이션 캡처는 실제 빌드된 React 화면을 브라우저로 열고 브라우저의 `/api/*` 요청만 결정적 합성 fixture로 가로챕니다. 실제 계좌나 토스증권 API에는 접속하지 않습니다.

- 시작 평가금: `10,000,000 KRW`
- KODEX 200 (`069500`): 20%
- KODEX 반도체 (`091160`): 20%
- KODEX 미국반도체 (`390390`): 15%
- TIGER 글로벌멀티에셋TIF액티브 (`440340`): 15%
- KODEX 미국나스닥100 (`379810`): 10%
- TIME 미국나스닥100액티브 (`426030`): 20%
- 기본 백테스트 시작일: 가장 늦은 상장일인 `2022-08-30`
- 기본 백테스트 종료일: `2026-07-16`

## 다시 생성하기

먼저 실제 프런트엔드를 빌드하고 프리뷰 서버를 실행합니다.

```bash
npm run build
npx vite preview --host 127.0.0.1 --port 4173
```

다른 터미널에서 캡처 스크립트를 실행합니다.

```bash
node scripts/capture-readme.mjs
```

프리뷰 주소가 다르면 `PRESENTATION_APP_URL`로 지정합니다. 애플리케이션 캡처 또는 아키텍처 슬라이드만 만들고 싶다면 각각 `PRESENTATION_SKIP_ARCHITECTURE=1`, `PRESENTATION_SKIP_APP=1`을 사용합니다.

모든 애플리케이션 이미지는 `1440×1100`, 아키텍처 이미지는 `1440×900` PNG로 생성됩니다. 아키텍처 원본 HTML은 그라데이션을 사용하지 않으며 `docs/assets/aws-icons`의 AWS 공식 Architecture Icon SVG를 그대로 참조합니다.
