import type { ToolName } from "../schemas.js";
import type { McpScopeId } from "../../auth/mcp-scope.js";

export type ToolMetadata = {
  title: string;
  description: string;
  scopes: McpScopeId[];
  annotations: {
    readOnlyHint: boolean;
    openWorldHint: boolean;
    destructiveHint: boolean;
  };
};

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false } as const;
const run = { readOnlyHint: false, openWorldHint: false, destructiveHint: false } as const;
const publicResult = { readOnlyHint: false, openWorldHint: true, destructiveHint: false } as const;
const destructive = { readOnlyHint: false, openWorldHint: false, destructiveHint: true } as const;

export const toolMetadata: Record<ToolName, ToolMetadata> = {
  search_instruments: { title: "종목 검색", description: "코드·이름·시장·자산유형으로 국내·미국 주식과 ETF를 검색합니다.", scopes: ["market:read"], annotations: readOnly },
  get_data_availability: { title: "데이터 가용성 조회", description: "종목별 수정주가 cache 기간·관측수와 공통 계산 기간을 확인합니다.", scopes: ["market:read"], annotations: readOnly },
  get_price_series: { title: "가격 시계열 조회", description: "수정 여부와 기준통화를 지정해 일·주·월 OHLC 시계열을 조회합니다.", scopes: ["market:read"], annotations: readOnly },
  analyze_technical_signals: { title: "기술적 지표·신호 분석", description: "기존 지표 batch 요청과 typed 기술 조건 신호-only 요청을 함께 지원합니다. 지표·조건 평가는 하나의 Rust batch를 사용하고 종가 신호는 다음 공통 실제 관측일에만 계획합니다.", scopes: ["market:read"], annotations: run },
  validate_technical_strategy: { title: "기술 신호 전략 검증", description: "typed 조건·지표 참조·allocation·백테스트 연결과 데이터 가용성을 Rust 계산 없이 검증합니다.", scopes: ["backtest:run"], annotations: readOnly },
  run_technical_strategy_backtest: { title: "기술 신호 전략 백테스트", description: "Rust에서 지표 계산→조건 평가→다음 안전 거래일 schedule→기존 ledger를 한 run으로 실행하며 주문은 만들지 않습니다.", scopes: ["backtest:run"], annotations: publicResult },
  analyze_instrument: { title: "개별 종목 분석", description: "수정주가 수익률의 성과·위험·낙폭·tail risk와 벤치마크 상대성과를 분석합니다.", scopes: ["market:read"], annotations: readOnly },
  analyze_asset_relationship: { title: "자산 관계 분석", description: "기준 종목과 비교 종목의 공통 관측일 수익률 상관·Beta·상대성과를 분석합니다.", scopes: ["market:read"], annotations: readOnly },
  get_correlation_matrix: { title: "상관행렬 조회", description: "여러 자산의 수정주가 수익률을 전체 공통 거래일로 inner join해 상관행렬을 계산합니다.", scopes: ["market:read"], annotations: readOnly },
  validate_backtest_config: { title: "백테스트 설정 검증", description: "백테스트 입력·비중·기간·데이터 가용성을 계산 실행 없이 검증합니다. presetId 사용 시 명시한 필드를 덮어쓰고 정책 부분 객체는 깊게 병합합니다.", scopes: ["backtest:run"], annotations: readOnly },
  run_portfolio_backtest: { title: "포트폴리오 백테스트", description: "현금·정수 수량·목표비중 정책·배당·세금·유동성 비용과 point-in-time universe를 ledger에 반영합니다. presetId 사용 시 명시한 필드를 덮어쓰고 정책 부분 객체는 깊게 병합합니다.", scopes: ["backtest:run"], annotations: publicResult },
  compare_backtests: { title: "백테스트 비교", description: "저장된 여러 백테스트 run의 지표·안정성·비용·데이터 품질을 비교합니다.", scopes: ["backtest:run"], annotations: readOnly },
  get_backtest_artifact: { title: "백테스트 산출물 조회", description: "equity·drawdown·trades·rolling 등 저장된 run 산출물을 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  get_run_artifact: { title: "실행 산출물 조회", description: "백테스트·최적화·검증·전망·노출·Pareto·연구 보고서 run의 저장 artifact를 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  get_current_portfolio: { title: "현재 포트폴리오 조회", description: "계좌 번호를 숨긴 opaque selector 기준으로 현재 종목과 원화 환산 비중을 조회합니다.", scopes: ["portfolio:read"], annotations: readOnly },
  find_diversifying_assets: { title: "분산 후보 탐색", description: "명시한 후보 또는 현재 cache universe에서 낮은 상관과 하락장 분산효과를 가진 자산을 찾습니다.", scopes: ["market:read"], annotations: readOnly },
  analyze_market_regimes: { title: "시장 국면 분석", description: "벤치마크 수익률과 rolling 변동성으로 상승·하락·고변동·저변동 국면을 통계적으로 분류합니다.", scopes: ["market:read"], annotations: readOnly },
  analyze_return_contribution: { title: "수익 기여 분석", description: "저장된 백테스트 run의 시간연결·현지가격·환율·위험 기여를 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  optimize_portfolio: { title: "포트폴리오 최적화", description: "기준·Pareto 후보를 탐색하고 표본 내/OOS robust score와 실제 ledger 재검증 순위·지표 차이를 제공합니다. presetId 사용 시 명시한 필드를 덮어쓰고 정책 부분 객체는 깊게 병합합니다.", scopes: ["backtest:run"], annotations: run },
  walk_forward_optimize: { title: "Walk-forward 최적화", description: "rolling·anchored 학습과 gap·embargo, fold 예산·seed를 적용해 stitched OOS 성과와 안정성을 검증합니다. presetId 사용 시 명시한 필드를 덮어쓰고 정책 부분 객체는 깊게 병합합니다.", scopes: ["backtest:run"], annotations: run },
  stress_test_portfolio: { title: "포트폴리오 스트레스 테스트", description: "비용·환율·현금흐름·리밸런싱·종목 제외 가정을 바꾼 복수 시나리오를 실행합니다.", scopes: ["backtest:run"], annotations: run },
  build_pareto_frontier: { title: "Pareto 전선 생성", description: "수익·변동성·MDD·CVaR·회전율·비용 기준 비지배 최적화 후보를 조회하며 async 모드에서는 취소 가능한 run과 artifact를 생성합니다.", scopes: ["backtest:run"], annotations: run },
  find_redundant_assets: { title: "중복 자산 탐지", description: "높은 상관·유사 Beta·낙폭 경로를 기준으로 중복 가능 자산 쌍을 찾습니다.", scopes: ["market:read"], annotations: readOnly },
  analyze_rebalance_plan: { title: "리밸런싱 계획 분석", description: "현재·목표 비중의 차이와 회전율·추정 비용을 계산하며 주문은 생성하지 않습니다.", scopes: ["backtest:run"], annotations: readOnly },
  analyze_weight_sensitivity: { title: "비중 민감도 분석", description: "특정 종목의 명시적 비중 범위에서 성과·위험 지표 변화를 실행합니다.", scopes: ["backtest:run"], annotations: run },
  analyze_start_date_sensitivity: { title: "시작일 민감도 분석", description: "시작일 이동에 따른 백테스트 성과와 위험 분포를 실행합니다.", scopes: ["backtest:run"], annotations: run },
  analyze_rebalance_sensitivity: { title: "리밸런싱 민감도 분석", description: "없음·월·분기·연·threshold 리밸런싱 가정을 비교합니다.", scopes: ["backtest:run"], annotations: run },
  analyze_cash_flow_sensitivity: { title: "현금흐름 민감도 분석", description: "정기 납입·인출 금액·주기·기간 내 시점 변화가 백테스트에 미치는 영향을 실행합니다.", scopes: ["backtest:run"], annotations: run },
  simulate_portfolio_monte_carlo: { title: "포트폴리오 Monte Carlo", description: "moving-block·stationary·regime bootstrap 또는 Student-t로 현금·비용·수량을 반영한 미래 분포와 calibration을 계산합니다.", scopes: ["backtest:run"], annotations: run },
  analyze_portfolio_outlook: { title: "포트폴리오 미래 전망", description: "Walk-forward OOS·Monte Carlo calibration·stress·시장 국면·ledger 민감도를 하나의 취소 가능한 역사적 전망 run으로 결합합니다.", scopes: ["backtest:run"], annotations: run },
  analyze_portfolio_exposures: { title: "포트폴리오 노출 분석", description: "sector·industry·국가·통화·자산유형·factor와 제공된 ETF 구성종목 look-through 노출을 집계하며 async 모드에서는 취소 가능한 run과 artifact를 생성합니다.", scopes: ["market:read"], annotations: run },
  explain_data_quality: { title: "데이터 품질 설명", description: "가격·환율·벤치마크 관측률과 공통 거래일·carry-forward·cache revision을 설명합니다.", scopes: ["market:read"], annotations: readOnly },
  get_run_status: { title: "실행 상태 조회", description: "비동기 run의 상태·진행률·완료 후보·검증 구간과 경고를 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  cancel_run: { title: "실행 취소", description: "대기·실행 중인 분석·검증·전망·노출·Pareto·연구 보고서 run을 취소하고 기존 완료 결과는 보존합니다.", scopes: ["backtest:run"], annotations: run },
  get_run_result: { title: "실행 결과 조회", description: "완료된 비동기 run의 요약·상위 후보·설정·artifact index를 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  list_runs: { title: "실행 기록 검색", description: "영구 run을 이름·종류·상태·태그·보관 여부로 검색하고 cursor 페이지로 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  get_run_events: { title: "실행 이벤트 조회", description: "run의 생성·시작·진행·취소·완료·재실행 이벤트를 시간순으로 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  export_run_manifest: { title: "재현성 manifest 내보내기", description: "입력·seed·data revision·Git/엔진/worker/MCP 버전과 artifact checksum을 고정한 manifest를 내보냅니다.", scopes: ["backtest:run"], annotations: readOnly },
  update_run: { title: "실행 기록 수정", description: "run의 표시 이름·태그·보관 상태만 수정하며 계산 결과와 manifest는 바꾸지 않습니다.", scopes: ["backtest:run"], annotations: run },
  duplicate_run: { title: "실행 복제", description: "기존 run 입력과 manifest 출처를 보존한 독립 실행 사본을 만듭니다.", scopes: ["backtest:run"], annotations: run },
  delete_run: { title: "실행 삭제", description: "run을 soft delete해 기본 목록과 결과 조회에서 숨기며 감사 가능한 복구 여지를 남깁니다.", scopes: ["backtest:run"], annotations: destructive },
  rerun_run: { title: "실행 재실행", description: "저장된 입력을 현재 data revision과 엔진에서 새 run으로 다시 실행합니다.", scopes: ["backtest:run"], annotations: run },
  list_portfolio_presets: { title: "포트폴리오 프리셋 검색", description: "백테스트·최적화 공통 프리셋을 이름·태그로 검색하고 마지막 사용 시각을 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  get_portfolio_preset: { title: "포트폴리오 프리셋 조회", description: "프리셋 snapshot과 선택적 변경 이력을 조회합니다.", scopes: ["backtest:run"], annotations: readOnly },
  create_portfolio_preset: { title: "포트폴리오 프리셋 생성", description: "수동 설정·현재 포트폴리오·run·최적화/Pareto 후보 snapshot으로 프리셋을 생성합니다.", scopes: ["backtest:run"], annotations: run },
  update_portfolio_preset: { title: "포트폴리오 프리셋 수정", description: "낙관적 revision 검증과 변경 이력을 남기며 프리셋을 수정합니다.", scopes: ["backtest:run"], annotations: run },
  duplicate_portfolio_preset: { title: "포트폴리오 프리셋 복제", description: "프리셋의 독립 snapshot 사본을 생성합니다.", scopes: ["backtest:run"], annotations: run },
  delete_portfolio_preset: { title: "포트폴리오 프리셋 삭제", description: "프리셋을 soft delete하고 기본 조회에서 숨깁니다.", scopes: ["backtest:run"], annotations: destructive },
  import_portfolio_presets: { title: "포트폴리오 프리셋 가져오기", description: "versioned JSON 문서를 검증해 프리셋을 가져오고 충돌 정책을 적용합니다.", scopes: ["backtest:run"], annotations: run },
  export_portfolio_preset: { title: "포트폴리오 프리셋 내보내기", description: "프리셋을 schema version이 있는 이식 가능한 JSON 문서로 내보냅니다.", scopes: ["backtest:run"], annotations: readOnly },
  generate_backtest_report: { title: "백테스트 보고서 생성", description: "완료된 run에 기존 AI writer와 보고서 저장소를 사용해 공개 보고서 페이지를 생성합니다.", scopes: ["report:generate"], annotations: publicResult },
  generate_research_report: { title: "연구 보고서 생성", description: "최적화·Walk-forward·Monte Carlo·stress·outlook run에서 재현 가능한 JSON 또는 Markdown 보고서를 생성하며 async 모드에서는 취소 가능한 파생 run과 artifact를 제공합니다.", scopes: ["report:generate"], annotations: publicResult },
  get_report: { title: "보고서 메타데이터 조회", description: "보고서 ID·유형·생성시각·run·모델·페이지 URL·data revision을 조회합니다.", scopes: ["report:generate"], annotations: readOnly },
};

export function securitySchemes(scopes: McpScopeId[]) {
  return [{ type: "oauth2", scopes }] as const;
}
