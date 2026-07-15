# Portfolio Lens

토스증권 Open API의 계좌·보유 주식·체결 완료 주문·일봉을 읽어 개인 포트폴리오의 현재 상태와 과거 비중을 보여주는 대시보드입니다. 주문 생성·정정·취소 엔드포인트는 구현하지 않았습니다.

## 실행

1. **.env.example**을 참고해 **.env**에 다음 값을 설정합니다.

   - **CLIENT_ID**, **CLIENT_SECRET**: 실제 토스증권 WTS에서 발급한 상위 Open API 자격증명
   - **DASHBOARD_PASSWORD**: 웹 로그인 비밀번호이자 이 앱이 노출하는 읽기 전용 API의 Bearer 토큰
   - **SESSION_SECRET**: 32자 이상의 임의 문자열
   - **SNAPSHOT_REFRESH_HOURS**: 일별 스냅샷 갱신 주기(기본 6시간)

2. Docker Compose로 실행합니다.

       docker compose up --build -d web

3. http://localhost:3200 또는 연결된 리버스 프록시 주소로 접속합니다.

서비스는 컨테이너와 호스트 모두 **0.0.0.0:3200**을 사용합니다. 상태 확인 주소는 **/api/health**입니다.

## 읽기 전용 토스 호환 API

이 앱은 실제 토스증권 자격증명을 외부에 전달하지 않고 토스증권과 같은 경로의 조회 전용 API를 제공합니다. 별도 토큰 발급 요청 없이 `.env`의 **DASHBOARD_PASSWORD** 자체를 Bearer 토큰으로 사용합니다.

    curl 'https://tpl.uaysk.com/api/v1/accounts' \
      -H 'Authorization: Bearer YOUR_DASHBOARD_PASSWORD'

이 토큰은 `.env`의 **DASHBOARD_PASSWORD**가 변경될 때까지 유효합니다. 계좌·보유자산 조회는 토스증권과 마찬가지로 보유 계좌의 식별자를 `X-Tossinvest-Account` 헤더에 전달합니다.

노출하는 GET 경로:

- 계좌·자산: `/api/v1/accounts`, `/api/v1/holdings`
- 거래 내역: `/api/v1/orders`, `/api/v1/orders/{orderId}` (`GET`만 지원)
- 시세: `/api/v1/orderbook`, `/api/v1/prices`, `/api/v1/trades`, `/api/v1/price-limits`, `/api/v1/candles`
- 종목: `/api/v1/stocks`, `/api/v1/stocks/{symbol}/warnings`
- 시장: `/api/v1/exchange-rate`, `/api/v1/market-calendar/KR`, `/api/v1/market-calendar/US`, `/api/v1/rankings`
- 지표: `/api/v1/market-indicators/prices`, `/api/v1/market-indicators/{symbol}/candles`, `/api/v1/market-indicators/{symbol}/investor-trading`

거래 내역 목록은 `status=OPEN|CLOSED`가 필수이며 `symbol`, `from`, `to`, `cursor`, `limit`만 추가로 허용합니다. 계좌 헤더와 Bearer 토큰 사용 예시는 다음과 같습니다.

    curl 'https://tpl.uaysk.com/api/v1/orders?status=CLOSED&limit=100' \
      -H 'Authorization: Bearer YOUR_DASHBOARD_PASSWORD' \
      -H 'X-Tossinvest-Account: ACCOUNT_SEQ'

매수 가능 금액, 매도 가능 수량, 수수료, 주문 생성·정정·취소와 조건주문 경로는 호환 API에 노출하지 않습니다. 임의 경로나 허용되지 않은 쿼리도 서버 화이트리스트에서 거부합니다.

## 일별 비중 차트

- 최초 실행 시 체결 완료 주문 전체를 커서 기반으로 조회해 사용자의 첫 체결일부터 현재까지 데이터를 복원합니다.
- 각 종목의 비수정 일봉 종가를 페이지 단위로 모두 불러오고, 매수·매도 체결 수량을 KST 날짜별로 반영합니다.
- 주말·휴일은 직전 거래일 종가를 이어 쓰고 오늘 데이터는 현재 보유 API의 실시간 평가액으로 기록합니다.
- 같은 날짜에 여러 번 조회하면 별도 점을 만들지 않고 그날의 최신 상태로 갱신합니다.
- 컨테이너가 실행 중이면 6시간마다 모든 조회 가능 계좌를 갱신하며, 대시보드 조회·새로고침 때도 오늘 스냅샷을 저장합니다.
- KRW와 USD를 분리합니다. 영역 두께는 각 통화 안의 종목 비중을 나타내고, 스택 전체 높이는 그날의 통화별 총평가금을 따라 변합니다.
- 현재 보유자산의 평가액·손익·수익률은 화면이 보이는 동안 5초마다 갱신합니다.
- 현재 해외주식 잔고가 없어도 과거 USD 주문과 일봉으로 복원한 해외주식 기록은 차트의 **USD · 해외/과거** 탭에서 확인할 수 있습니다.
- 7일, 30일, 90일, 전체 기간을 빠르게 선택하거나 시작일·종료일 달력 입력으로 KST 일 단위 범위를 직접 지정할 수 있습니다.
- 체결 합계와 현재 보유량이 다른 종목(입고·출고, 액면분할 등)은 현재 보유량에 맞춰 기준 수량을 보정하고 UI에 **일부 추정**으로 표시합니다.
- 데이터는 Docker named volume **portfolio_data**의 **/app/data/portfolio-history.sqlite**에 유지됩니다.

첫 동기화는 보유·과거 보유 종목 수에 따라 시간이 걸릴 수 있습니다. 진행 상태는 비중 차트 상단에서 확인할 수 있고, 완료되면 차트가 자동 갱신됩니다.

대시보드는 다크 테마가 기본이며, 로그인 화면과 대시보드 상단 버튼으로 라이트 테마를 선택할 수 있습니다. 상단 표시 설정에서는 현재 보유 종목뿐 아니라 선택한 차트 기간에 등장하는 매도 완료 종목도 숨기거나 다시 표시할 수 있습니다. 숨긴 종목은 보유 목록, 자산 구성, 과거 차트에서 제외되지만 계좌 합계는 바뀌지 않습니다. 자산 구성에는 평가액 상위 10종목과 나머지 합계가 표시됩니다. 각 종목은 차트와 목록에서 일관된 컬러로 표시됩니다. 선택한 테마와 숨긴 종목 키만 현재 브라우저의 로컬 저장소에 보관합니다.

## 보안과 데이터 흐름

- 브라우저는 토스증권 자격증명을 직접 받지 않습니다.
- 서버는 실제 토스증권의 OAuth 토큰을 메모리에만 보관하고, 계좌·자산·시장 데이터의 GET 조회와 과거 차트 복원용 CLOSED 주문 GET만 호출합니다.
- 외부 호환 API는 앱의 **DASHBOARD_PASSWORD** 자체를 `Authorization: Bearer ...` 토큰으로 일정 시간 비교해 확인합니다. 별도의 호환 토큰을 발급하거나 저장하지 않습니다.
- 액세스 토큰은 프로세스 메모리에만 캐시하며 디스크나 브라우저에 저장하지 않습니다.
- 로그인 세션은 HMAC 서명된 HttpOnly, SameSite=Strict 쿠키이며 12시간 후 만료됩니다.
- 로그인은 IP별 15분 동안 5회 실패 제한을 적용합니다.
- KRW와 USD 금액은 환율로 임의 합산하지 않고 통화별로 표시합니다.
- SQLite에는 읽어 온 체결 주문, 종목 메타데이터, 일봉 종가, 백필 진행 상태, 날짜별 평가액과 계산된 비중을 저장합니다. 토스 자격증명과 액세스 토큰은 저장하지 않습니다.

## 문제 해결

- **invalid_client**: CLIENT_ID 또는 CLIENT_SECRET이 다르거나 토스증권 Open API 클라이언트가 비활성 상태인지 확인합니다.
- **access_denied**: 토스증권 WTS의 Open API 허용 IP 관리에서 서버의 외부 IP를 등록합니다.
- 리버스 프록시에서 HTTPS를 사용하면 세션 쿠키에 Secure 속성이 자동 적용됩니다.

정확한 요청·응답 형식은 [토스증권 Open API 문서](https://developers.tossinvest.com/docs)를 기준으로 합니다.
