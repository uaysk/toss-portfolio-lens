import type { BacktestRunRequest, PortfolioBacktestService } from "../backtest.js";
import type { ArtifactType } from "../repositories/artifact-repository.js";
import type { PortfolioRunRecord } from "../repositories/run-repository.js";
import type { MarketDataService } from "./market-data-service.js";
import type { RunService } from "./run-service.js";
import type { ReportService, GeneratedReportMetadata } from "./report-service.js";
import type { ArtifactService } from "./artifact-service.js";
import { envelope, PORTFOLIO_ENGINE_VERSION, requestHash, ServiceError } from "./service-envelope.js";

export type BacktestReportOption = {
  enabled?: boolean;
  failure_mode?: "warn" | "fail";
};

export type SharedBacktestRequest = BacktestRunRequest & {
  report?: BacktestReportOption;
};

type BacktestRunResult = Awaited<ReturnType<PortfolioBacktestService["run"]>>;

function artifacts(result: BacktestRunResult): Array<{ type: ArtifactType; content: unknown; rowCount?: number }> {
  return [
    { type: "equity", content: result.points, rowCount: result.points.length },
    {
      type: "drawdown",
      content: result.points.map((point) => ({ date: point.date, drawdownPercent: point.drawdownPercent })),
      rowCount: result.points.length,
    },
    {
      type: "holdings",
      content: result.contributions.map((item) => ({
        date: result.endDate,
        symbol: item.symbol,
        name: item.name,
        currency: item.currency,
        ending_value: item.endingValue,
        ending_weight: result.metrics.finalBalance > 0 ? item.endingValue / result.metrics.finalBalance : 0,
      })),
      rowCount: result.contributions.length,
    },
    { type: "trades", content: result.trades, rowCount: result.trades.length },
    { type: "rolling", content: result.advanced.rolling, rowCount: result.advanced.rolling.length },
    { type: "correlation", content: result.correlations, rowCount: result.correlations.assets.length },
    { type: "risk-contribution", content: result.advanced.riskContributions, rowCount: result.advanced.riskContributions.length },
    { type: "monthly-returns", content: result.advanced.monthlyReturns, rowCount: result.advanced.monthlyReturns.length },
  ];
}

export class BacktestService {
  constructor(
    private readonly engine: PortfolioBacktestService,
    private readonly marketData: MarketDataService,
    private readonly runs: RunService,
    private readonly artifacts: ArtifactService,
    private readonly reports: ReportService,
  ) {}

  async validate(request: BacktestRunRequest): Promise<ReturnType<typeof envelope>> {
    const instruments = await this.engine.resolveInstruments(request.assets.map((asset) => asset.symbol));
    const availability = await this.marketData.getDataAvailability(instruments.map((instrument) => instrument.symbol), true);
    const weightTotal = request.assets.reduce((sum, asset) => sum + asset.weight, 0);
    const errors: Array<{ field: string; message: string }> = [];
    const warnings: string[] = [];
    if (Math.abs(weightTotal - 100) > 0.01) errors.push({ field: "assets", message: "종목 비중 합계는 100%여야 합니다." });
    if (request.assets.some((asset) => !Number.isFinite(asset.weight) || asset.weight <= 0)) errors.push({ field: "assets", message: "각 종목 비중은 0보다 커야 합니다." });
    if (new Set(request.assets.map((asset) => asset.symbol.toUpperCase())).size !== request.assets.length) errors.push({ field: "assets", message: "중복 종목을 제거해 주세요." });
    if (request.startDate > request.endDate) errors.push({ field: "startDate", message: "시작일은 종료일보다 빠르거나 같아야 합니다." });
    if (!Number.isFinite(request.initialAmount) || request.initialAmount < 10_000 || request.initialAmount > 10_000_000_000_000) errors.push({ field: "initialAmount", message: "초기 투자금 범위를 확인해 주세요." });
    if (!Number.isFinite(request.monthlyCashFlow) || Math.abs(request.monthlyCashFlow) > 1_000_000_000_000) errors.push({ field: "monthlyCashFlow", message: "정기 현금흐름 범위를 확인해 주세요." });
    if ((request.transactionCostBps ?? 0) < 0 || (request.transactionCostBps ?? 0) > 500) errors.push({ field: "transactionCostBps", message: "거래비용은 0~500bp 범위여야 합니다." });
    if (request.rebalanceFrequency === "threshold" && (request.rebalanceThresholdPercent === undefined
      || request.rebalanceThresholdPercent < 0.1 || request.rebalanceThresholdPercent > 50)) {
      errors.push({ field: "rebalanceThresholdPercent", message: "threshold 리밸런싱 기준은 0.1~50% 범위여야 합니다." });
    }
    if (request.benchmark === "CUSTOM" && !request.benchmarkSymbol) errors.push({ field: "benchmarkSymbol", message: "CUSTOM 벤치마크 종목이 필요합니다." });
    if (availability.commonPeriod && (
      request.endDate < availability.commonPeriod.from || request.startDate > availability.commonPeriod.to
    )) {
      errors.push({ field: "startDate", message: "요청 기간과 공통 데이터 기간이 겹치지 않습니다." });
    }
    const customBenchmarkAvailability = request.benchmark === "CUSTOM" && request.benchmarkSymbol
      ? await this.marketData.getDataAvailability([request.benchmarkSymbol], true)
      : undefined;
    const benchmarkAvailability = request.benchmark !== "NONE" && request.benchmark !== "CUSTOM"
      ? await this.engine.getCachedBenchmarkAvailability(request.benchmark, request.startDate, request.endDate)
      : request.benchmark === "CUSTOM"
        ? customBenchmarkAvailability?.assets[0]
        : undefined;
    if (request.benchmark !== "NONE" && !benchmarkAvailability?.observations) {
      warnings.push("요청 벤치마크의 선택 기간 cache 관측이 없습니다. 실행 시 공급자에서 조회를 시도합니다.");
    }
    const needsFx = (request.currencyMode ?? "KRW") === "KRW" && instruments.some((instrument) => instrument.currency === "USD");
    const fxAvailability = needsFx
      ? await this.marketData.getCachedExchangeRateAvailability(request.startDate, request.endDate)
      : undefined;
    if (needsFx && !fxAvailability?.observations) warnings.push("선택 기간 USD/KRW cache 관측이 없습니다. 실행 시 공급자에서 조회를 시도합니다.");
    return envelope({
      request,
      dataRevision: availability.dataRevision,
      requestedPeriod: { from: request.startDate, to: request.endDate },
      effectivePeriod: availability.commonPeriod,
      result: { valid: errors.length === 0, errors, availability, benchmark_availability: benchmarkAvailability, fx_availability: fxAvailability },
      assumptions: ["검증은 계산을 실행하지 않으며 현재 cache와 종목 메타데이터만 확인합니다."],
      warnings,
      dataQuality: { weight_total: weightTotal, asset_count: request.assets.length, common_observations: availability.commonObservations },
    });
  }

  async run(input: {
    ownerSubject: string;
    request: SharedBacktestRequest;
  }): Promise<ReturnType<typeof envelope>> {
    const { report, ...backtestRequest } = input.request;
    const reportOption = {
      enabled: report?.enabled ?? false,
      failure_mode: report?.failure_mode ?? "warn" as const,
    };
    const initialRevision = await this.marketData.repository.dataRevision();
    const reusable = await this.runs.findReusable({
      ownerSubject: input.ownerSubject,
      kind: "backtest",
      config: backtestRequest,
      dataRevision: initialRevision,
    });
    let executed: { run: PortfolioRunRecord; reused: boolean };
    if (reusable) {
      executed = { run: reusable, reused: true };
    } else {
      const calculated = await this.engine.run(backtestRequest);
      const calculatedRevision = await this.marketData.repository.dataRevision();
      executed = await this.runs.execute({
        ownerSubject: input.ownerSubject,
        kind: "backtest",
        config: backtestRequest,
        dataRevision: calculatedRevision,
        task: async () => ({
          summary: calculated.metrics,
          result: calculated,
          warnings: calculated.warnings,
          artifacts: artifacts(calculated),
        }),
      });
    }
    const dataRevision = executed.run.dataRevision;
    const result = executed.run.result as BacktestRunResult | undefined;
    if (!result) throw new ServiceError({ code: "RUN_RESULT_NOT_FOUND", message: "완료된 백테스트 결과를 찾을 수 없습니다.", retryable: true });
    let reportResult: {
      requested: boolean;
      generated: boolean;
      reused?: boolean;
      id?: string;
      url?: string;
      status?: "failed";
      error?: { code: string; retryable: boolean };
    } = { requested: false, generated: false };
    const warnings = [...result.warnings];
    if (reportOption.enabled) {
      try {
        const generated = await this.reports.generateBacktest({
          runId: executed.run.id,
          ownerSubject: input.ownerSubject,
          backtestRequestHash: requestHash(backtestRequest),
          dataRevision,
          engineVersion: PORTFOLIO_ENGINE_VERSION,
          reportConfig: reportOption,
          result,
        });
        reportResult = {
          requested: true,
          generated: true,
          reused: generated.reused,
          id: generated.id,
          url: generated.url,
        };
      } catch (error) {
        reportResult = {
          requested: true,
          generated: false,
          status: "failed",
          error: { code: "REPORT_GENERATION_FAILED", retryable: true },
        };
        if (reportOption.failure_mode === "fail") {
          throw new ServiceError({
            code: "REPORT_GENERATION_FAILED",
            message: "백테스트는 완료되었지만 보고서를 생성하지 못했습니다.",
            retryable: true,
            details: { run_id: executed.run.id },
          });
        }
        warnings.push("보고서 생성에 실패했습니다. 백테스트 실행 결과와 artifact는 보존되었습니다.");
      }
    }
    return envelope({
      request: backtestRequest,
      dataRevision,
      generatedAt: result.generatedAt,
      requestedPeriod: { from: backtestRequest.startDate, to: backtestRequest.endDate },
      effectivePeriod: { from: result.effectiveStartDate, to: result.endDate },
      assumptions: [
        `currency_mode=${backtestRequest.currencyMode ?? "KRW"}`,
        "수정주가를 사용하며 별도 현금배당·세금·슬리피지는 포함하지 않습니다.",
      ],
      warnings,
      dataQuality: result.dataQuality,
      result: {
        run_id: executed.run.id,
        reused: executed.reused,
        summary: result.metrics,
        benchmark: result.benchmarkMetrics,
        contributions: result.contributions,
        artifact_index: await this.artifacts.list(executed.run.id),
        report: reportResult,
      },
    });
  }

  async generateReport(input: {
    ownerSubject: string;
    run: PortfolioRunRecord;
    reportConfig?: unknown;
  }): Promise<GeneratedReportMetadata> {
    if (input.run.status !== "completed" || !input.run.result) {
      throw new ServiceError({ code: "RUN_NOT_COMPLETE", message: "완료된 백테스트 run이 필요합니다.", retryable: false });
    }
    return this.reports.generateBacktest({
      runId: input.run.id,
      ownerSubject: input.ownerSubject,
      backtestRequestHash: input.run.requestHash,
      dataRevision: input.run.dataRevision,
      engineVersion: input.run.engineVersion,
      reportConfig: input.reportConfig,
      result: input.run.result as BacktestRunResult,
    });
  }

}
