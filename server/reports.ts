import { randomUUID } from "node:crypto";
import type { PortfolioAnalysis } from "./analysis.js";
import type { PortfolioBacktestService } from "./backtest.js";
import {
  OpenAiReportWriter,
  parseReportNarrative,
  ReportGenerationError,
  type ReportNarrative,
} from "./report-ai.js";
import type { ReportStorage } from "./report-storage.js";

export const REPORT_TEMPLATE_VERSION = "portfolio-report-v1" as const;
export type BacktestResult = Awaited<ReturnType<PortfolioBacktestService["run"]>>;
export type PublicPortfolioAnalysis = Omit<PortfolioAnalysis, "accountId">;

type ReportBase = {
  schemaVersion: 1;
  templateVersion: typeof REPORT_TEMPLATE_VERSION;
  id: string;
  createdAt: string;
  title: string;
  narrative: ReportNarrative;
};

export type AnalysisReport = ReportBase & {
  kind: "analysis";
  period: { from: string; to: string };
  data: PublicPortfolioAnalysis;
};

export type BacktestReport = ReportBase & {
  kind: "backtest";
  period: { from: string; to: string };
  data: BacktestResult;
};

export type StoredReport = AnalysisReport | BacktestReport;
type ReportWriter = Pick<OpenAiReportWriter, "evaluate">;

export function isReportId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sample<T>(values: T[], maximum = 28): T[] {
  if (values.length <= maximum) return values;
  const indexes = Array.from({ length: maximum }, (_, index) => Math.round(index * (values.length - 1) / (maximum - 1)));
  return Array.from(new Set(indexes)).map((index) => values[index]);
}

export function analysisEvaluationInput(analysis: PublicPortfolioAnalysis): unknown {
  const base = analysis.candles[0]?.close ?? 0;
  return {
    reportType: "actual-portfolio-analysis",
    generatedAt: analysis.generatedAt,
    period: { from: analysis.fromDate, to: analysis.toDate },
    currency: analysis.baseCurrency,
    includesCurrencies: analysis.includesCurrencies,
    metrics: analysis.metrics,
    benchmarkComparisons: analysis.benchmarkComparisons ?? [],
    rollingAnalytics: {
      latest: analysis.rolling?.at(-1),
      history: sample(analysis.rolling ?? [], 56),
    },
    drawdownAnalysis: analysis.drawdowns ? {
      ...analysis.drawdowns,
      points: sample(analysis.drawdowns.points, 56),
    } : undefined,
    tailRisk: analysis.tailRisk,
    monthlyReturns: analysis.monthlyReturns ?? [],
    exposure: analysis.exposure,
    riskContributions: analysis.riskContributions ?? [],
    correlations: analysis.correlations,
    costEfficiency: analysis.costEfficiency,
    tradeBehavior: analysis.tradeBehavior,
    benchmarkErrors: analysis.benchmarkErrors,
    performanceContributions: analysis.contributions,
    attributionByKey: analysis.attributionByKey,
    trajectory: sample(analysis.candles).map((candle) => ({
      date: candle.date,
      changeFromStartPercent: base > 0 ? round(((candle.close / base) - 1) * 100) : 0,
    })),
    dataQuality: {
      estimatedOhlc: analysis.estimatedOhlc,
      ohlcBackfillComplete: analysis.ohlcBackfillComplete,
      fxBackfillComplete: analysis.fxBackfillComplete,
      includesCurrencies: analysis.includesCurrencies,
      coverage: analysis.dataQuality,
      limitations: [
        "계좌 입출금·예수금·배당 원장이 제공되지 않아 계좌 전체 성과가 아닌 보유주식 추정 성과입니다.",
        "TWR은 전일 보유비중과 종목·환율 수익률을 연결한 추정값입니다.",
        "XIRR은 시작 평가액, 매수·매도 체결, 종료 평가액을 이용한 추정값입니다.",
      ],
    },
  };
}

export function backtestEvaluationInput(backtest: BacktestResult): unknown {
  return {
    reportType: "portfolio-backtest",
    generatedAt: backtest.generatedAt,
    period: { from: backtest.effectiveStartDate, to: backtest.endDate },
    currency: backtest.baseCurrency,
    assumptions: { ...backtest.config, currencyMethod: backtest.currencyMethod },
    assets: backtest.assets,
    benchmark: backtest.benchmark,
    metrics: backtest.metrics,
    benchmarkMetrics: backtest.benchmarkMetrics,
    annualReturns: backtest.annualReturns,
    performanceContributions: backtest.contributions,
    correlations: backtest.correlations,
    advancedAnalytics: backtest.advanced,
    trajectory: sample(backtest.points).map((point) => ({
      date: point.date,
      portfolioGrowth: point.growth,
      benchmarkGrowth: point.benchmarkGrowth,
      drawdownPercent: point.drawdownPercent,
    })),
    warnings: backtest.warnings,
  };
}

function validateStoredReport(value: unknown, expectedId: string): StoredReport {
  if (!value || typeof value !== "object") throw new Error("저장된 보고서 형식이 올바르지 않습니다.");
  const report = value as Partial<StoredReport> & Record<string, unknown>;
  if (report.schemaVersion !== 1 || report.templateVersion !== REPORT_TEMPLATE_VERSION || report.id !== expectedId
    || (report.kind !== "analysis" && report.kind !== "backtest")
    || typeof report.createdAt !== "string" || typeof report.title !== "string"
    || !report.period || typeof report.period !== "object"
    || !report.data || typeof report.data !== "object") {
    throw new Error("저장된 보고서 형식이 올바르지 않습니다.");
  }
  report.narrative = parseReportNarrative(report.narrative);
  return report as StoredReport;
}

export class PortfolioReportService {
  constructor(
    private readonly storage: ReportStorage,
    private readonly publicAppUrl: string,
    private readonly writer?: ReportWriter,
  ) {}

  get storageBackend(): "local" | "s3" {
    return this.storage.backend;
  }

  get generationConfigured(): boolean {
    return Boolean(this.writer);
  }

  publicUrl(id: string): string {
    return `${this.publicAppUrl.replace(/\/+$/, "")}/reports/${id}`;
  }

  private requireWriter(): ReportWriter {
    if (!this.writer) {
      throw new ReportGenerationError("OPENAI_API_ENDPOINT와 OPENAI_API_KEY 설정이 필요합니다.");
    }
    return this.writer;
  }

  async createAnalysis(analysis: PortfolioAnalysis): Promise<AnalysisReport> {
    const { accountId: _accountId, ...publicAnalysis } = analysis;
    const narrative = await this.requireWriter().evaluate(analysisEvaluationInput(publicAnalysis));
    const report: AnalysisReport = {
      schemaVersion: 1,
      templateVersion: REPORT_TEMPLATE_VERSION,
      id: randomUUID(),
      kind: "analysis",
      createdAt: new Date().toISOString(),
      title: "포트폴리오 평가 보고서",
      period: { from: analysis.fromDate, to: analysis.toDate },
      narrative,
      data: publicAnalysis,
    };
    await this.storage.put(report.id, report);
    return report;
  }

  async createBacktest(backtest: BacktestResult): Promise<BacktestReport> {
    const narrative = await this.requireWriter().evaluate(backtestEvaluationInput(backtest));
    const report: BacktestReport = {
      schemaVersion: 1,
      templateVersion: REPORT_TEMPLATE_VERSION,
      id: randomUUID(),
      kind: "backtest",
      createdAt: new Date().toISOString(),
      title: "백테스트 평가 보고서",
      period: { from: backtest.effectiveStartDate, to: backtest.endDate },
      narrative,
      data: backtest,
    };
    await this.storage.put(report.id, report);
    return report;
  }

  async get(id: string): Promise<StoredReport | undefined> {
    if (!isReportId(id)) return undefined;
    const value = await this.storage.get(id);
    return value === undefined ? undefined : validateStoredReport(value, id);
  }
}
