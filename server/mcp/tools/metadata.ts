import type { ToolName } from "../schemas.js";
import type { McpScopeId } from "../../auth/mcp-scope.js";

export type ToolMetadata = {
  title: string;
  description: string;
  scopes: McpScopeId[];
  annotations: {
    readOnlyHint: boolean;
    openWorldHint: boolean;
    destructiveHint: false;
  };
};

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false } as const;
const run = { readOnlyHint: false, openWorldHint: false, destructiveHint: false } as const;
const publicResult = { readOnlyHint: false, openWorldHint: true, destructiveHint: false } as const;

export const toolMetadata: Record<ToolName, ToolMetadata> = {
  search_instruments: { title: "종목 검색", description: "코드·이름·시장·자산유형으로 국내·미국 주식과 ETF를 검색합니다.", scopes: ["market:read"], annotations: readOnly },
  get_data_availability: { title: "데이터 가용성 조회", description: "종목별 수정주가 cache 기간·관측수와 공통 계산 기간을 확인합니다.", scopes: ["market:read"], annotations: readOnly },
  get_price_series: { title: "가격 시계열 조회", description: "수정 여부와 기준통화를 지정해 일·주·월 OHLC 시계열을 조회합니다.", scopes: ["market:read"], annotations: readOnly },
  analyze_instrument: { title: "개별 종목 분석", description: "수정주가 수익률의 성과·위험·낙폭·tail risk와 벤치마크 상대성과를 분석합니다.", scopes: ["market:read"], annotations: readOnly },
  analyze_asset_relationship: { title: "자산 관계 분석", description: "기준 종목과 비교 종목의 공통 관측일 수익률 상관·Beta·상대성과를 분석합니다.", scopes: ["market:read"], annotations: readOnly },
  get_correlation_matrix: { title: "상관행렬 조회", description: "여러 자산의 수정주가 수익률을 전체 공통 거래일로 inner join해 상관행렬을 계산합니다.", scopes: ["market:read"], annotations: readOnly },
  validate_backtest_config: { title: "백테스트 설정 검증", description: "백테스트 입력·비중·기간·데이터 가용성을 계산 실행 없이 검증합니다.", scopes: ["backtest:run"], annotations: readOnly },
  run_portfolio_backtest: { title: "포트폴리오 백테스트", description: "공용 백테스트 엔진으로 현금흐름·리밸런싱·비용·환율을 반영한 역사적 시뮬레이션을 실행합니다.", scopes: ["backtest:run"], annotations: publicResult },
  compare_backtests: { title: "백테스트 비교", description: "저장된 여러 백테스트 run의 지표·안정성·비용·데이터 품질을 비교합니다.", scopes: ["backtest:run"], annotations: readOnly },
  get_backtest_artifact: { title: "백테스트 산출물 조회", description: "equity·drawdown·trades·rolling 등 저장된 run 산출물을 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  get_current_portfolio: { title: "현재 포트폴리오 조회", description: "계좌 번호를 숨긴 opaque selector 기준으로 현재 종목과 원화 환산 비중을 조회합니다.", scopes: ["portfolio:read"], annotations: readOnly },
  find_diversifying_assets: { title: "분산 후보 탐색", description: "명시한 후보 또는 현재 cache universe에서 낮은 상관과 하락장 분산효과를 가진 자산을 찾습니다.", scopes: ["market:read"], annotations: readOnly },
  analyze_market_regimes: { title: "시장 국면 분석", description: "벤치마크 수익률과 rolling 변동성으로 상승·하락·고변동·저변동 국면을 통계적으로 분류합니다.", scopes: ["market:read"], annotations: readOnly },
  analyze_return_contribution: { title: "수익 기여 분석", description: "저장된 백테스트 run의 시간연결·현지가격·환율·위험 기여를 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  optimize_portfolio: { title: "포트폴리오 최적화", description: "seed와 제약을 고정해 결정론적 후보를 생성하고 선택 목적별 최적 비중을 탐색합니다.", scopes: ["backtest:run"], annotations: run },
  walk_forward_optimize: { title: "Walk-forward 최적화", description: "학습 구간 최적 비중을 다음 OOS 구간에서 검증하고 안정성과 선택 빈도를 계산합니다.", scopes: ["backtest:run"], annotations: run },
  stress_test_portfolio: { title: "포트폴리오 스트레스 테스트", description: "비용·환율·현금흐름·리밸런싱·종목 제외 가정을 바꾼 복수 시나리오를 실행합니다.", scopes: ["backtest:run"], annotations: run },
  build_pareto_frontier: { title: "Pareto 전선 생성", description: "수익·변동성·MDD·CVaR·회전율·비용 기준 비지배 최적화 후보를 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  find_redundant_assets: { title: "중복 자산 탐지", description: "높은 상관·유사 Beta·낙폭 경로를 기준으로 중복 가능 자산 쌍을 찾습니다.", scopes: ["market:read"], annotations: readOnly },
  analyze_rebalance_plan: { title: "리밸런싱 계획 분석", description: "현재·목표 비중의 차이와 회전율·추정 비용을 계산하며 주문은 생성하지 않습니다.", scopes: ["backtest:run"], annotations: readOnly },
  analyze_weight_sensitivity: { title: "비중 민감도 분석", description: "특정 종목의 명시적 비중 범위에서 성과·위험 지표 변화를 실행합니다.", scopes: ["backtest:run"], annotations: run },
  analyze_start_date_sensitivity: { title: "시작일 민감도 분석", description: "시작일 이동에 따른 백테스트 성과와 위험 분포를 실행합니다.", scopes: ["backtest:run"], annotations: run },
  analyze_rebalance_sensitivity: { title: "리밸런싱 민감도 분석", description: "없음·월·분기·연·threshold 리밸런싱 가정을 비교합니다.", scopes: ["backtest:run"], annotations: run },
  analyze_cash_flow_sensitivity: { title: "현금흐름 민감도 분석", description: "정기 납입·인출 금액·주기·기간 내 시점 변화가 백테스트에 미치는 영향을 실행합니다.", scopes: ["backtest:run"], annotations: run },
  simulate_portfolio_monte_carlo: { title: "포트폴리오 Monte Carlo", description: "자산 간 상관을 보존하는 moving-block bootstrap으로 미래 경로 분포·낙폭·손실·목표 달성 확률을 계산합니다.", scopes: ["backtest:run"], annotations: run },
  explain_data_quality: { title: "데이터 품질 설명", description: "가격·환율·벤치마크 관측률과 공통 거래일·carry-forward·cache revision을 설명합니다.", scopes: ["market:read"], annotations: readOnly },
  get_run_status: { title: "실행 상태 조회", description: "비동기 run의 상태·진행률·완료 후보·검증 구간과 경고를 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  cancel_run: { title: "실행 취소", description: "실행 중인 최적화·Walk-forward·stress·민감도 run을 취소하고 기존 결과는 보존합니다.", scopes: ["backtest:run"], annotations: run },
  get_run_result: { title: "실행 결과 조회", description: "완료된 비동기 run의 요약·상위 후보·설정·artifact index를 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  generate_backtest_report: { title: "백테스트 보고서 생성", description: "완료된 run에 기존 AI writer와 보고서 저장소를 사용해 공개 보고서 페이지를 생성합니다.", scopes: ["report:generate"], annotations: publicResult },
  get_report: { title: "보고서 메타데이터 조회", description: "보고서 ID·유형·생성시각·run·모델·페이지 URL·data revision을 조회합니다.", scopes: ["report:generate"], annotations: readOnly },
};

export function securitySchemes(scopes: McpScopeId[]) {
  return [{ type: "oauth2", scopes }] as const;
}
