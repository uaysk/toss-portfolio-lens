# README presentation assets

이 디렉터리는 프로젝트 README에 넣을 실제 애플리케이션 화면과 아키텍처 슬라이드의 재현 가능한 원본을 관리합니다.

## 화면 데이터

현재 README에 커밋된 애플리케이션 화면은 실제 빌드된 React 화면을 브라우저로 열고, 아래 예시 포트폴리오의 실제 수정주가 및 백테스트 결과를 주입해 캡처했습니다. 실제 계좌 보유내역은 사용하지 않습니다. `capture-readme.mjs`의 기본 fixture는 오프라인 레이아웃 재현을 위한 대체 데이터입니다.

- 시작 평가금: `10,000,000 KRW`
- KODEX 200 (`069500`): 20%
- KODEX 반도체 (`091160`): 20%
- KODEX 미국반도체 (`390390`): 15%
- TIGER 글로벌멀티에셋TIF액티브 (`440340`): 15%
- KODEX 미국나스닥100 (`379810`): 10%
- TIME 미국나스닥100액티브 (`426030`): 20%
- 그래프 요청 시작일: `2025-03-01` (첫 공통 거래일 `2025-03-04`)
- 그래프·백테스트 종료일: `2026-07-15`
- 실제 가격 관측치: `335`거래일

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

현재 애플리케이션 이미지는 CSS 기준 1,600px 너비와 2배 픽셀 밀도로 전체 페이지를 캡처하여 가로 3,200px PNG로 생성했습니다. 아키텍처 이미지는 `1440×900`이며, 원본 HTML은 그라데이션을 사용하지 않고 `docs/assets/aws-icons`의 AWS 공식 Architecture Icon SVG를 그대로 참조합니다.
