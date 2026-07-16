# Requirements Document

## 1. 목적과 용어

이 Spec은 기존 소스 코드를 복사하지 않고도 Toss Portfolio Lens의 최종 확정 기능을 다시 구현할 수 있게 한다.

- **상위 API**: 실제 토스증권 Open API
- **호환 API**: 이 애플리케이션이 `/api/v1` 아래에 제공하는 제한된 조회 전용 프록시
- **현재 포트폴리오**: 토스증권 보유자산 API가 반환하는 현재 보유 주식
- **복원 포트폴리오**: 체결 완료 주문, 종목 일봉, 환율로 첫 체결일부터 재구성한 일별 보유 주식
- **평가액**: 현금·예수금을 제외한 보유 주식 평가액
- **보고서**: 서버가 계산한 지표와 LLM 평가 문구를 고정 React 템플릿으로 보여 주는 문서

요구사항의 `SHALL`은 필수, `SHOULD`는 특별한 사유가 없으면 구현해야 하는 항목이다.

## 2. 요구사항

### Requirement 1 — 실행 환경과 구성

**User story:** 운영자로서 환경 변수와 Docker Compose만으로 서비스를 재현 가능하게 실행하고 싶다.

#### Acceptance criteria

1. WHEN 서버가 시작되면 THE SYSTEM SHALL `HOST=0.0.0.0`, `PORT=3200`을 기본값으로 사용한다.
2. WHEN 필수 환경 변수 `CLIENT_ID`, `CLIENT_SECRET`, `DASHBOARD_PASSWORD`, `SESSION_SECRET` 중 하나가 없으면 THE SYSTEM SHALL 비밀값을 로그에 노출하지 않는 명확한 구성 오류로 시작을 중단한다.
3. WHEN `DASHBOARD_PASSWORD`가 비어 있거나 `SESSION_SECRET`이 32자 미만이면 THE SYSTEM SHALL 안전하지 않은 구성으로 시작하지 않는다. `DASHBOARD_PASSWORD`에는 별도의 최소 글자 수를 강제하지 않는다.
4. WHEN `PUBLIC_APP_URL` 또는 호환 별칭 `APP_URL`이 설정되면 THE SYSTEM SHALL 프로토콜·호스트를 검증하고 보고서 URL의 기준 주소로 사용한다.
5. WHEN Docker Compose를 실행하면 THE SYSTEM SHALL 애플리케이션을 `0.0.0.0:3200`에 노출하고 SQLite 데이터 및 로컬 보고서용 named volume을 유지한다.
6. THE SYSTEM SHALL `.env.example`, `.gitignore`, `.dockerignore`, 멀티스테이지 Dockerfile, 운영 README를 제공한다.

### Requirement 2 — 비밀번호 로그인과 세션

**User story:** 개인 금융 대시보드에 비밀번호를 아는 사용자만 접근하게 하고 싶다.

#### Acceptance criteria

1. WHEN 사용자가 올바른 `DASHBOARD_PASSWORD`를 제출하면 THE SYSTEM SHALL 일정 시간 비교 후 HMAC 서명 세션 쿠키를 발급한다.
2. THE SYSTEM SHALL 세션 쿠키에 `HttpOnly`, `SameSite=Strict`, `Path=/`, 12시간 만료를 적용하고 HTTPS 요청에서는 `Secure`를 적용한다.
3. WHEN 동일 IP에서 15분 동안 로그인에 5회 실패하면 THE SYSTEM SHALL 해당 창이 끝날 때까지 추가 시도를 `429`로 제한한다.
4. WHEN 로그인이 성공하면 THE SYSTEM SHALL 해당 IP의 실패 상태를 초기화한다.
5. WHEN 사용자가 로그아웃하면 THE SYSTEM SHALL 세션 쿠키를 즉시 만료한다.
6. WHEN 보호된 웹 API에 유효한 세션이 없으면 THE SYSTEM SHALL `401`을 반환하고 SPA는 로그인 화면으로 전환한다.
7. THE SYSTEM SHALL 다중 프로세스 배포 시 외부 rate-limit 저장소가 필요할 수 있음을 문서화한다. 기본 단일 태스크에서는 메모리 제한기를 사용할 수 있다.

### Requirement 3 — 토스증권 조회 전용 클라이언트

**User story:** 실제 자격증명을 브라우저에 노출하지 않고 계좌 정보를 조회하고 싶다.

#### Acceptance criteria

1. THE SYSTEM SHALL `CLIENT_ID`와 `CLIENT_SECRET`을 상위 API의 인증에만 사용하고 브라우저 응답·로그·DB에 기록하지 않는다.
2. WHEN 상위 액세스 토큰이 유효하면 THE SYSTEM SHALL 프로세스 메모리에서만 재사용하고 디스크에 저장하지 않는다.
3. WHEN 토큰이 만료되거나 인증 오류가 발생하면 THE SYSTEM SHALL 동시 재발급 요청을 하나로 합치고 안전하게 한 번 갱신한다.
4. THE SYSTEM SHALL 계좌, 보유자산, 체결 완료 주문, 종목·시세·일봉·환율·시장지수에 필요한 GET 요청만 구현한다.
5. THE SYSTEM SHALL 주문 생성·정정·취소와 그에 준하는 mutation 요청을 코드 경로와 UI 모두에서 제공하지 않는다.
6. WHEN 상위 API가 오류를 반환하면 THE SYSTEM SHALL 허용 가능한 `400`, `404`, `429`를 보존하고 인증·네트워크·5xx 오류는 비밀 응답 본문을 노출하지 않는 `502` 계열 오류로 매핑한다.
7. THE SYSTEM SHALL 모든 상위 요청에 timeout과 request cancellation을 적용한다.

### Requirement 4 — 제한된 토스 호환 API

**User story:** 실제 토스 자격증명을 공유하지 않고 익숙한 조회 경로로 데이터를 읽고 싶다.

#### Acceptance criteria

1. WHEN 요청이 `Authorization: Bearer <DASHBOARD_PASSWORD>`를 포함하면 THE SYSTEM SHALL 일정 시간 비교로 토큰을 검증한다.
2. THE SYSTEM SHALL 별도 호환 API token을 생성·저장하지 않고 `DASHBOARD_PASSWORD` 자체를 token으로 사용한다.
3. THE SYSTEM SHALL 다음 GET 경로만 허용한다: `/api/v1/accounts`, `/api/v1/holdings`, `/api/v1/orders`, `/api/v1/orders/{orderId}`, `/api/v1/orderbook`, `/api/v1/prices`, `/api/v1/trades`, `/api/v1/price-limits`, `/api/v1/candles`, `/api/v1/stocks`, `/api/v1/stocks/{symbol}/warnings`, `/api/v1/exchange-rate`, `/api/v1/market-calendar/{country}`, `/api/v1/rankings`, `/api/v1/market-indicators/prices`, `/api/v1/market-indicators/{symbol}/candles`, `/api/v1/market-indicators/{symbol}/investor-trading`.
4. WHEN 계좌 단위 경로가 호출되면 THE SYSTEM SHALL 숫자 형식의 `X-Tossinvest-Account` 헤더를 요구한다.
5. WHEN 주문 목록을 조회하면 THE SYSTEM SHALL `status=OPEN|CLOSED`를 필수로 하고 `symbol`, `from`, `to`, `cursor`, `limit` 외 쿼리를 거부한다.
6. WHEN 허용되지 않은 메서드·경로·쿼리가 요청되면 THE SYSTEM SHALL 거래 API로 전달하지 않고 `operation-not-supported` 또는 `invalid-request` 오류를 반환한다.
7. THE SYSTEM SHALL 호환 API 응답에 `Cache-Control: no-store`를 적용한다.

### Requirement 5 — 현재 포트폴리오 대시보드

**User story:** 로그인 후 국내·해외 보유자산의 최신 상태를 한눈에 보고 싶다.

#### Acceptance criteria

1. WHEN 대시보드가 열리면 THE SYSTEM SHALL 계좌 목록과 선택 계좌의 보유자산을 가져온다.
2. THE SYSTEM SHALL 평가액, 매입액, 평가손익, 수익률, 일간손익, 보유 종목 수, 기준 시각을 표시한다.
3. THE SYSTEM SHALL 국내와 해외 주식을 같은 보유 목록에 표시하고 각 행에는 원본 통화, 수량, 평균단가, 현재가, 평가액, 평가손익을 보존한다.
4. WHEN 화면이 보이고 사용자가 로그인 상태이면 THE SYSTEM SHALL 현재 포트폴리오를 5초마다 갱신한다.
5. WHEN 브라우저 탭이 숨겨지면 THE SYSTEM SHOULD 불필요한 5초 요청을 중지하고 다시 보일 때 즉시 갱신한다.
6. WHEN 계좌를 변경하거나 컴포넌트가 해제되면 THE SYSTEM SHALL 이전 요청을 취소하고 오래된 응답이 새 계좌 상태를 덮어쓰지 않게 한다.
7. THE SYSTEM SHALL 사용자가 수동 새로고침과 계좌 선택을 할 수 있게 한다.
8. THE SYSTEM SHALL 자산 구성에 선택 통화 기준 평가액 상위 10종목과 나머지 합계를 표시한다.
9. THE SYSTEM SHALL 보유 주식 평가액 패널을 장식 원형 없이 단색으로 구성하고 기존 두 표면색 중 더 어두운 색을 사용한다.

### Requirement 6 — 첫 거래일부터의 과거 데이터 복원

**User story:** 현재 보유하지 않는 과거 종목까지 포함해 투자 시작일부터 일별 포트폴리오 변화를 보고 싶다.

#### Acceptance criteria

1. WHEN 계좌가 처음 동기화되면 THE SYSTEM SHALL 커서 기반으로 모든 `CLOSED` 주문을 읽고 가장 이른 체결일을 찾는다.
2. THE SYSTEM SHALL 국내·해외 과거 종목의 메타데이터와 비수정 OHLC 일봉을 페이지 단위로 첫 체결일부터 현재까지 수집한다.
3. THE SYSTEM SHALL 분석과 통합 차트에 필요한 일별 USD/KRW 환율을 수집·캐시한다.
4. WHEN 각 KST 날짜를 재구성하면 THE SYSTEM SHALL 그날까지의 매수·매도 체결 수량과 종가를 적용해 종목별 평가액을 계산한다.
5. WHEN 주말·휴일에 체결이나 가격이 없으면 THE SYSTEM SHALL 직전 유효 보유수량·가격·환율을 이어 쓰되 미래 가격을 역으로 사용하지 않는다.
6. WHEN 오늘을 기록하면 THE SYSTEM SHALL 상위 보유자산 API의 최신 평가액으로 같은 날짜 스냅샷을 upsert한다.
7. WHEN 누적 체결 수량과 현재 보유량이 다르면 THE SYSTEM SHALL 현재 보유량과 일치하도록 기준 수량을 보정하고 결과를 `일부 추정`으로 표시한다.
8. THE SYSTEM SHALL 동기화 상태에 단계, 첫 거래일, 주문 수, 종목 진행 수, 가격 수, 스냅샷 수, 불일치 수, 실패 수와 메시지를 저장한다.
9. WHEN 일부 종목의 과거 시세 조회가 실패하면 THE SYSTEM SHALL 전체 작업을 버리지 않고 partial 상태와 실패 목록을 남겨 재시도할 수 있게 한다.
10. THE SYSTEM SHALL 시작 시, 수동 요청 시, 대시보드 조회 시 오늘 기록을 갱신하고 실행 중에는 기본 6시간 간격으로 계좌별 snapshot을 수집한다.

### Requirement 7 — 종목별 일별 누적 Area 차트

**User story:** 각 종목이 날짜별로 포트폴리오에서 차지한 금액과 비중을 직관적으로 보고 싶다.

#### Acceptance criteria

1. THE SYSTEM SHALL 국내·해외 종목을 일별 USD/KRW 환율로 원화 환산해 하나의 누적 Area 차트에 동시에 표시한다.
2. THE SYSTEM SHALL 고정 100% 높이가 아니라 각 날짜의 보유 주식 총평가액을 누적 높이로 사용한다.
3. THE SYSTEM SHALL 7일, 30일, 90일, 전체 프리셋과 KST 일 단위 시작일·종료일 달력 입력을 제공한다.
4. WHEN 사용자가 마우스 또는 포인터를 날짜 위에 놓으면 THE SYSTEM SHALL 별도 tooltip 창을 띄우지 않고 각 Area 영역 내부에 종목명을 표시한다.
5. WHEN 해당 날짜의 종목 평가액이 0이면 THE SYSTEM SHALL 그 종목명을 표시하지 않는다.
6. WHEN Area 두께가 이름을 넣기에 부족하면 THE SYSTEM SHALL 해당 계열과 같은 색의 leader line을 영역에서 뽑아 충돌하지 않는 위치에 이름을 표시한다.
7. THE SYSTEM SHALL Area 자체의 stroke/외곽선을 제거하고 단색 fill만 사용한다.
8. THE SYSTEM SHALL 그라데이션을 사용하지 않고 다크 테마에서 구분되는 결정적 유채색 팔레트를 종목 key에 매핑한다.
9. THE SYSTEM SHALL 범례에 종목명과 선택 기간 평균 비중을 표시하고 같은 종목에 모든 화면에서 같은 색을 사용한다.
10. WHEN 데이터가 없거나 동기화 중이거나 모든 종목이 숨김 상태이면 THE SYSTEM SHALL 각각 구분되는 empty/loading 상태를 보여 준다.

### Requirement 8 — 표시 설정, 테마, 반응형 UI

**User story:** 원하는 종목만 보고 선호 테마와 화면 크기에 맞춰 대시보드를 사용하고 싶다.

#### Acceptance criteria

1. THE SYSTEM SHALL 다크 테마를 기본으로 하고 로그인·대시보드·보고서에서 라이트 테마 전환 버튼을 제공한다.
2. THE SYSTEM SHALL 선택 테마를 브라우저 localStorage에 저장하고 첫 paint 전에 적용해 깜박임을 줄인다.
3. THE SYSTEM SHALL 흑백·회색 표면을 중심으로 하고 카드 외곽선과 UI·차트 그라데이션을 사용하지 않는다.
4. THE SYSTEM SHALL 데이터 계열 구분 외에는 유채색을 의미 없는 장식으로 사용하지 않는다.
5. WHEN 표시 설정을 열면 THE SYSTEM SHALL 현재 보유 종목과 선택한 과거 차트에 존재하는 매도 완료 종목을 함께 나열한다.
6. WHEN 종목을 숨기면 THE SYSTEM SHALL 보유 목록, 자산 구성, 과거 Area 차트에서만 제외하고 서버의 계좌 합계나 원본 데이터는 바꾸지 않는다.
7. THE SYSTEM SHALL 숨긴 종목 key만 localStorage에 저장하며 금융 수치나 계좌 ID를 브라우저 영구 저장소에 저장하지 않는다.
8. THE SYSTEM SHALL 320px 이상 화면에서 가로 overflow 없이 동작하고 데스크톱 sidebar와 모바일 3개 탭 탐색을 제공한다.
9. THE SYSTEM SHALL 키보드 탐색, visible focus, label, `aria-live`, 충분한 대비, reduced-motion 고려를 적용한다.

### Requirement 9 — SQLite, MySQL, 자동 마이그레이션

**User story:** 로컬에서는 SQLite로 간단히 시작하고 MySQL이 준비되면 기존 데이터를 잃지 않고 전환하고 싶다.

#### Acceptance criteria

1. WHEN MySQL 관련 값이 없거나 불완전하면 THE SYSTEM SHALL `DATABASE_PATH`의 SQLite를 사용한다.
2. WHEN `MYSQL_URL` 또는 완전한 개별 MySQL 설정이 있고 연결·schema 준비가 성공하면 THE SYSTEM SHALL MySQL을 주 저장소로 사용한다.
3. WHEN MySQL이 선택되는데 기존 SQLite 파일이 있으면 THE SYSTEM SHALL snapshot, snapshot item, order, instrument, daily price, backtest price, benchmark price, exchange rate, backfill state를 transaction으로 idempotent upsert한다.
4. WHEN MySQL 행이 SQLite 원본보다 최신이면 THE SYSTEM SHALL 더 최신인 MySQL 행을 덮어쓰지 않는다.
5. THE SYSTEM SHALL SQLite fingerprint와 migration metadata를 저장해 변경되지 않은 파일의 반복 마이그레이션을 건너뛴다.
6. WHEN MySQL이 일시 실패하고 로컬 모드에서 fallback이 허용되면 THE SYSTEM SHALL SQLite로 동작하고 다음 연결 성공 때 새 변경분을 다시 마이그레이션한다.
7. WHEN `MYSQL_REQUIRED=true`이면 THE SYSTEM SHALL MySQL 연결 또는 migration 실패 시 SQLite로 silently fallback하지 않고 readiness 실패로 시작을 중단한다.
8. THE SYSTEM SHALL SQLite 원본을 자동 삭제하거나 변경하지 않는다.
9. THE SYSTEM SHALL SQLite와 MySQL에 동일한 저장소 contract와 schema semantics를 제공한다.

### Requirement 10 — 포트폴리오 분석 차트와 벤치마크

**User story:** 보유주식 평가액의 일봉 형태와 주요 시장지수를 같은 기간·같은 기준점에서 비교하고 싶다.

#### Acceptance criteria

1. THE SYSTEM SHALL 분석을 별도 탭으로 제공하고 국내·해외 포지션을 일별 환율로 원화 환산해 동시에 계산한다.
2. THE SYSTEM SHALL 종목별 보유수량과 일봉 OHLC를 합산한 포트폴리오 추정 open/high/low/close를 일봉 candlestick으로 표시한다.
3. THE SYSTEM SHALL 종목별 장중 극값 시각이 다르므로 포트폴리오 high/low가 추정값임을 화면에 명시한다.
4. THE SYSTEM SHALL KOSPI, KOSDAQ, Nasdaq-100과 S&P 500을 선택적으로 비교한다. 미국 지수 직접 데이터가 불가능하면 QQQ와 SPY 수정주가를 명시된 proxy로 사용한다.
5. WHEN 분석 기간을 선택하면 THE SYSTEM SHALL 30일, 90일, 1년, 전체와 직접 날짜 범위를 지원한다.
6. WHEN 포트폴리오와 선택 벤치마크를 그리면 THE SYSTEM SHALL 요청 범위 안의 공통 기준일을 정하고 모든 표시 계열을 그 날짜의 0%에서 시작하게 한다.
7. WHEN 벤치마크가 공통 기준일에 값을 제공하지 못하면 THE SYSTEM SHALL 직전 유효값 전달 또는 해당 계열 제외 규칙을 일관되게 적용하고 오류를 표시하며 미래 값을 과거로 역전파하지 않는다.
8. THE SYSTEM SHALL 벤치마크 원본 가격을 선택된 DB에 cache하고 일부 지수 실패가 나머지 분석을 막지 않게 한다.
9. THE SYSTEM SHALL 매도 때문에 보유 주식 평가액이 줄 수 있음을 구분하고, 성과 지표에는 체결 현금흐름으로 조정한 추정 수익률을 별도로 제공한다.
10. THE SYSTEM SHALL 입출금·예수금 원장 없이 매도대금을 현금 평가액으로 임의 추가하지 않는다.

### Requirement 11 — 분석 지표와 기여도

**User story:** 수익, 위험, 위험 대비 성과, 벤치마크, 집중도와 기여도를 한 화면에서 확인하고 싶다.

#### Acceptance criteria

1. THE SYSTEM SHALL 평가액 변화율, 체결 조정 추정 수익률, TWR 추정치, XIRR 추정치, 연환산 수익률을 표시한다.
2. THE SYSTEM SHALL 연환산 변동성, MDD, 현재 drawdown, 최대 drawdown 기간, Sharpe, Sortino, Calmar를 표시한다.
3. THE SYSTEM SHALL 최고·최저 일간 수익률과 상승일 비율을 표시한다.
4. THE SYSTEM SHALL Top 3 비중, HHI, 유효 종목 수를 표시한다.
5. THE SYSTEM SHALL 각 벤치마크 수익률과 초과수익률을 표시한다.
6. THE SYSTEM SHALL 기간 매수액, 매도액, 수수료, 세금, 회전율, 거래 수, 순투자액과 추정 손익을 표시한다.
7. THE SYSTEM SHALL 종목별 추정 손익과 수익 기여도를 국내·해외 구분 없이 같은 목록에 표시한다.
8. WHEN 기여도를 정렬하면 THE SYSTEM SHALL 절댓값이 아니라 부호가 있는 원래 기여값을 내림차순으로 정렬해 양수 기여가 음수 기여보다 먼저 나오게 한다.
9. WHEN 표본 수가 부족하거나 분모가 0이거나 연율화가 의미 없으면 THE SYSTEM SHALL 숫자를 조작하지 않고 `N/A`와 사유를 표시한다.
10. THE SYSTEM SHALL 무위험수익률 기본 가정과 연율화 거래일 수를 계산 코드와 UI 설명에 명시한다.

### Requirement 12 — 포트폴리오 백테스트

**User story:** 현재 포트폴리오 또는 직접 구성한 국내·해외 종목으로 과거 전략을 비교하고 싶다.

#### Acceptance criteria

1. THE SYSTEM SHALL 백테스트를 별도 탭으로 제공한다.
2. WHEN 현재 포트폴리오 불러오기를 선택하면 THE SYSTEM SHALL 현재 국내·해외 보유종목과 원화 환산 평가 비중을 가져온다.
3. THE SYSTEM SHALL 국내 6자리 종목 코드와 미국 ticker를 직접 검색·추가하고 최대 20종목을 허용한다.
4. WHEN 구성 종목이 정해지면 THE SYSTEM SHALL 가장 늦은 상장일을 기본 시작일로, 현재 KST 날짜를 기본 종료일로 설정한다.
5. WHEN 일부 종목 데이터가 더 늦게 시작되면 THE SYSTEM SHALL 모든 종목과 선택 벤치마크가 공통으로 존재하는 첫 날짜를 실제 시작일로 사용하고 요청일과 실제일을 모두 표시한다.
6. THE SYSTEM SHALL 초기 투자금, 월별 납입 또는 인출, 리밸런싱 없음·월·분기·연 단위를 지원한다.
7. THE SYSTEM SHALL 비중 합계, 날짜 순서, 금액 범위, 종목 중복, 최대 종목 수를 서버에서 검증한다.
8. THE SYSTEM SHALL KOSPI, KOSDAQ, Nasdaq-100, S&P 500, 사용자가 입력한 국내·해외 개별 종목 또는 비교 없음 중 하나를 지원한다.
9. THE SYSTEM SHALL 포트폴리오 성장, 납입 누계, 벤치마크 성장, drawdown, 연도별 수익률, 종목별 기여도, 일간 수익률 상관행렬을 제공한다.
10. THE SYSTEM SHALL ending value, total return, CAGR, 연환산 변동성, MDD와 기간, Sharpe, Sortino, best/worst year, positive month 비율을 제공한다.
11. THE SYSTEM SHALL 국내·해외 혼합 백테스트가 현지 통화 수정주가 수익률을 합성하며 과거 FX, 명시적 배당 현금흐름, 세금, 수수료, spread, slippage를 반영하지 않는다는 한계를 표시한다.
12. WHEN 일간 수익률 상관행렬을 표시하면 THE SYSTEM SHALL 상단 열 머리글과 왼쪽 행 머리글에 종목 코드가 아닌 종목명을 우선 표시하고, 종목명이 없을 때만 코드를 대신 사용한다.
13. WHEN 벤치마크가 선택되면 THE SYSTEM SHALL 포트폴리오와 동일한 공통 거래일 구간에서 누적수익률, CAGR, 연환산 변동성, MDD와 기간, Sharpe, Sortino, 최고 연도, 상승 월 비율을 계산하고 각 포트폴리오 수치 바로 아래에 벤치마크 수치를 표시한다.
14. THE SYSTEM SHALL 일간 수익률 상관행렬의 셀을 유채색 없이 상관계수 절댓값에 따른 무채색 명도 차이로 표현하고 수치의 부호는 텍스트로 유지한다.

### Requirement 13 — AI 평가 보고서 생성

**User story:** 선택한 분석 기간 또는 백테스트 결과를 정형화된 시각 보고서로 저장하고 공유하고 싶다.

#### Acceptance criteria

1. WHEN 분석 보고서를 요청하면 THE SYSTEM SHALL 서버에서 account ID에 해당하는 선택 기간과 벤치마크 지표를 다시 계산한다.
2. WHEN 백테스트 보고서를 요청하면 THE SYSTEM SHALL 서버에서 동일 종목·비중·기간·현금흐름·리밸런싱 조건을 다시 실행한다.
3. THE SYSTEM SHALL LLM 입력에서 account ID와 모든 비밀값을 제거하고 수치, 표본 경로, 데이터 품질, 계산 한계만 전송한다.
4. WHEN `OPENAI_MODEL`이 설정되면 THE SYSTEM SHALL 그 모델을 사용하고, 없으면 `/models` 응답에서 Responses API와 호환되는 우선순위 모델을 결정적으로 선택한다.
5. THE SYSTEM SHALL Responses API에 `store=false`, timeout, 낮은 reasoning budget과 strict JSON schema를 사용한다.
6. THE SYSTEM SHALL LLM이 `score(0..100)`, `stance`, 한국어 `summary`, 정확히 3개의 `strengths`, `risks`, `actions`, `methodology`만 반환하게 검증한다.
7. THE SYSTEM SHALL LLM이 HTML, CSS, 차트 값 또는 템플릿을 생성하게 하지 않는다.
8. WHEN LLM 응답이 거절·timeout·rate limit·schema 불일치이면 THE SYSTEM SHALL retry 가능 여부를 구분한 안전한 오류를 표시하고 불완전 보고서를 저장하지 않는다.
9. THE SYSTEM SHALL 매수·매도 지시, 수익 보장, 제공되지 않은 뉴스·전망 추측을 평가 문구에서 금지한다.

### Requirement 14 — 고정 보고서 템플릿과 저장

**User story:** 모든 보고서가 같은 디자인과 안전한 URL 구조로 열리길 원한다.

#### Acceptance criteria

1. THE SYSTEM SHALL 모든 보고서를 versioned `portfolio-report-v1` React 템플릿으로 렌더링한다.
2. THE SYSTEM SHALL 다크 기본/라이트 전환, 흑백 표면, 무외곽선·무그라데이션, interactive chart와 metric card를 대시보드와 일관되게 제공한다.
3. THE SYSTEM SHALL `crypto.randomUUID()`에 준하는 불투명 ID를 발급하고 `${PUBLIC_APP_URL}/reports/{id}`로 노출한다.
4. THE SYSTEM SHALL 보고서 목록 API와 순차 ID를 제공하지 않는다.
5. WHEN `S3_BUCKET`이 없으면 THE SYSTEM SHALL `REPORTS_PATH` 아래에 원자적으로 JSON을 저장한다.
6. WHEN `S3_BUCKET`이 있으면 THE SYSTEM SHALL AWS SDK credential provider chain과 `S3_REGION`, `S3_PREFIX`, 선택적 호환 endpoint를 사용해 private object로 저장한다.
7. THE SYSTEM SHALL 저장 report에서 account ID를 제거하고 `schemaVersion`, `templateVersion`, 종류, 기간, 생성시각, narrative와 계산 data만 보관한다.
8. WHEN 보고서를 제공하면 THE SYSTEM SHALL `Cache-Control: no-store`, `X-Robots-Tag: noindex, noarchive`를 적용한다.
9. WHEN report ID 형식이 잘못됐거나 object가 없으면 THE SYSTEM SHALL 존재 여부를 과도하게 누설하지 않는 동일한 `404`를 반환한다.

### Requirement 15 — 상태 확인, 오류와 관측성

**User story:** 운영자로서 데이터 저장소와 보고서 기능 상태를 비밀 누출 없이 확인하고 싶다.

#### Acceptance criteria

1. THE SYSTEM SHALL `/api/health`에서 process health, 선택 DB backend(`sqlite|mysql`), report storage(`local|s3`), report generation availability를 반환한다.
2. THE SYSTEM SHALL health 응답에 host, credential, 계좌 ID, object key, secret ARN과 같은 민감 구성을 포함하지 않는다.
3. THE SYSTEM SHALL API 오류를 `{ error: { code, message, requestId? } }` 형식으로 일관되게 반환한다.
4. THE SYSTEM SHALL 로그에 기능 범주와 upstream request ID는 기록할 수 있지만 request authorization, cookie, secret, 전체 금융 payload는 기록하지 않는다.
5. WHEN 서버가 종료 신호를 받으면 THE SYSTEM SHALL HTTP server, timer와 DB connection을 순서대로 종료한다.

### Requirement 16 — 테스트와 완료 기준

**User story:** 재구현 결과가 계산·보안·UI 회귀를 자동으로 탐지하길 원한다.

#### Acceptance criteria

1. THE SYSTEM SHALL 인증 쿠키, rate limit, Bearer token, GET allowlist, 금지 경로 테스트를 제공한다.
2. THE SYSTEM SHALL SQLite schema, MySQL adapter, idempotent migration, 최신 행 보호, fallback/required mode 테스트를 제공한다.
3. THE SYSTEM SHALL 주문 재구성, 휴일 carry-forward, 수량 보정, FX 환산, 날짜 경계 테스트를 제공한다.
4. THE SYSTEM SHALL TWR, XIRR, CAGR, 변동성, MDD, Sharpe, Sortino, Calmar, HHI, 기여도와 정렬 테스트를 제공한다.
5. THE SYSTEM SHALL 백테스트 cash flow, rebalance, 공통 시작일, 상관계수와 누락 데이터 테스트를 제공한다.
6. THE SYSTEM SHALL Area label 내부/leader line/0값 제외, date range, 종목 숨김, 색상 결정성 테스트를 제공한다.
7. THE SYSTEM SHALL LLM strict schema, 개인식별 제거, local/S3 storage, report route와 header 테스트를 제공한다.
8. WHEN Docker image를 빌드하면 THE SYSTEM SHALL typecheck, 전체 test, production build를 통과해야 한다.
9. WHEN 완료 검증을 수행하면 THE SYSTEM SHALL 실제 브라우저에서 320px 모바일과 데스크톱, dark/light, 로그인, 3개 탭, report route를 렌더링해 레이아웃과 콘솔 오류를 확인한다.

### Requirement 17 — 데이터 한계의 정직한 표현

**User story:** 제공되지 않은 원장 때문에 생기는 차이를 오해하지 않고 싶다.

#### Acceptance criteria

1. THE SYSTEM SHALL 평가금이 보유 주식 평가액이며 예수금과 외부 현금은 포함하지 않는다고 명시한다.
2. THE SYSTEM SHALL 계좌 입출금·환전·배당 원장이 없으므로 TWR와 XIRR이 보유주식 및 체결 기반 추정치라고 명시한다.
3. WHEN 사용자가 전량 매도하면 THE SYSTEM SHALL 보유 주식 평가액 차트가 감소할 수 있으며 이를 투자 손실이라고 단정하지 않는다.
4. THE SYSTEM SHALL WTS 텍스트 붙여넣기와 HTML 거래내역 추출 기능을 제공하지 않는다.
5. THE SYSTEM SHALL 백테스트와 AI 보고서에 과거 성과가 미래 성과를 보장하지 않는다는 한계를 표시한다.
