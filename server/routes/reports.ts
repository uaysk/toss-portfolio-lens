import { Router, type RequestHandler, type Response } from "express";
import {
  analysisToday,
  parseBenchmarkKeys,
  type AnalysisRange,
  type PortfolioAnalysis,
  type PortfolioAnalysisService,
} from "../analysis.js";
import type { BacktestRunRequest } from "../backtest.js";
import { BacktestValidationError } from "../backtest-engine.js";
import { isHistoryDate } from "../history.js";
import { ReportGenerationError } from "../report-ai.js";
import { isReportId, type StoredReport } from "../reports.js";
import type { BacktestRunResult } from "../services/backtest-service.js";
import { setNoStore } from "../auth.js";
import { TossApiError } from "../toss.js";
import { parseBacktestPayload } from "./backtest-payload.js";

type AnalysisRequest = Parameters<PortfolioAnalysisService["getAnalysis"]>[0];
type CreatedReport = {
  id: string;
  createdAt: string;
};

export type ReportRouteDependencies<
  TAnalysis = PortfolioAnalysis,
  TBacktest = BacktestRunResult,
  TStoredReport = StoredReport,
> = {
  authenticate: RequestHandler;
  portfolioAnalysis: {
    getAnalysis: (request: AnalysisRequest) => Promise<TAnalysis>;
  };
  portfolioReports: {
    createAnalysis: (analysis: TAnalysis) => Promise<CreatedReport>;
    createBacktest: (backtest: TBacktest) => Promise<CreatedReport>;
    get: (id: string) => Promise<TStoredReport | undefined>;
    publicUrl: (id: string) => string;
    storageBackend: "local" | "s3";
  };
  backtests: {
    runRaw: (input: { ownerSubject: string; request: BacktestRunRequest }) => Promise<TBacktest>;
  };
  today?: () => string;
  logError?: (scope: "reports" | "report-read", error: unknown) => void;
};

function defaultLogError(scope: "reports" | "report-read", error: unknown): void {
  const message = error instanceof Error ? error.message : error;
  console.error(
    scope === "reports" ? "[reports] 보고서 처리 실패:" : "[reports] 저장된 보고서 조회 실패:",
    message,
  );
}

export function sendBacktestError(response: Response, error: unknown): void {
  if (error instanceof BacktestValidationError) {
    response.status(400).json({ error: { code: "invalid-backtest", message: error.message } });
    return;
  }
  if (error instanceof TossApiError) {
    const status = error.status === 404 || error.status === 429 ? error.status : 502;
    response.status(status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.requestId ? { requestId: error.requestId } : {}),
      },
    });
    return;
  }
  console.error("[backtest]", error instanceof Error ? error.message : error);
  response.status(502).json({
    error: { code: "backtest-unavailable", message: "백테스트 데이터를 계산하지 못했습니다." },
  });
}

function reportError(
  response: Response,
  error: unknown,
  logError: ReportRouteDependencies["logError"],
): void {
  if (error instanceof ReportGenerationError) {
    response.status(error.retryable ? 503 : 422).json({
      error: { code: "report-generation-failed", message: error.message },
    });
    return;
  }
  (logError ?? defaultLogError)("reports", error);
  response.status(502).json({
    error: { code: "report-unavailable", message: "보고서를 생성하거나 저장하지 못했습니다." },
  });
}

export function createReportsRouter<
  TAnalysis = PortfolioAnalysis,
  TBacktest = BacktestRunResult,
  TStoredReport = StoredReport,
>(dependencies: ReportRouteDependencies<TAnalysis, TBacktest, TStoredReport>): Router {
  const router = Router();
  const today = dependencies.today ?? analysisToday;
  const logError = dependencies.logError ?? defaultLogError;

  router.post("/api/reports/portfolio-analysis", dependencies.authenticate, async (request, response) => {
    setNoStore(response);
    const body = request.body && typeof request.body === "object"
      ? request.body as Record<string, unknown>
      : {};
    const accountId = typeof body.account === "string" ? body.account.trim() : "";
    const range = ["30d", "90d", "1y", "all"].includes(String(body.range))
      ? body.range as AnalysisRange
      : undefined;
    const fromDate = typeof body.from === "string" ? body.from.trim() : "";
    const toDate = typeof body.to === "string" ? body.to.trim() : "";
    const riskFreeRatePercent = typeof body.riskFreeRate === "number" ? body.riskFreeRate : 0;
    if (!accountId || accountId.length > 128 || !range || !isHistoryDate(fromDate) || !isHistoryDate(toDate)
      || fromDate > toDate || toDate > today() || !Number.isFinite(riskFreeRatePercent)
      || riskFreeRatePercent < -10 || riskFreeRatePercent > 50) {
      response.status(400).json({
        error: { code: "invalid-report-range", message: "계좌와 보고서 분석 기간을 확인해 주세요." },
      });
      return;
    }
    try {
      const benchmarkKeys = body.benchmarks === "" ? [] : parseBenchmarkKeys(body.benchmarks);
      const analysis = await dependencies.portfolioAnalysis.getAnalysis({
        accountId,
        range,
        fromDate,
        toDate,
        benchmarkKeys,
        riskFreeRatePercent,
      });
      const report = await dependencies.portfolioReports.createAnalysis(analysis);
      response.status(201).json({
        id: report.id,
        url: dependencies.portfolioReports.publicUrl(report.id),
        createdAt: report.createdAt,
        storage: dependencies.portfolioReports.storageBackend,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("지원하는 비교 지수")) {
        response.status(400).json({ error: { code: "invalid-benchmark", message: error.message } });
        return;
      }
      reportError(response, error, logError);
    }
  });

  router.post("/api/reports/backtest", dependencies.authenticate, async (request, response) => {
    setNoStore(response);
    try {
      const result = await dependencies.backtests.runRaw({
        ownerSubject: "owner",
        request: parseBacktestPayload(request.body),
      });
      const report = await dependencies.portfolioReports.createBacktest(result);
      response.status(201).json({
        id: report.id,
        url: dependencies.portfolioReports.publicUrl(report.id),
        createdAt: report.createdAt,
        storage: dependencies.portfolioReports.storageBackend,
      });
    } catch (error) {
      if (error instanceof BacktestValidationError || error instanceof TossApiError) {
        sendBacktestError(response, error);
        return;
      }
      reportError(response, error, logError);
    }
  });

  router.get("/api/reports/:reportId", async (request, response) => {
    setNoStore(response);
    const id = String(request.params.reportId ?? "");
    if (!isReportId(id)) {
      response.status(404).json({
        error: { code: "report-not-found", message: "보고서를 찾을 수 없습니다." },
      });
      return;
    }
    try {
      const report = await dependencies.portfolioReports.get(id);
      if (!report) {
        response.status(404).json({
          error: { code: "report-not-found", message: "보고서를 찾을 수 없습니다." },
        });
        return;
      }
      response.json(report);
    } catch (error) {
      logError("report-read", error);
      response.status(500).json({
        error: { code: "report-read-failed", message: "보고서를 불러오지 못했습니다." },
      });
    }
  });

  return router;
}
