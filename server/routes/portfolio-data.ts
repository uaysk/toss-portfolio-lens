import { Router, type Request, type RequestHandler } from "express";
import {
  analysisStartDate,
  analysisToday,
  parseBenchmarkKeys,
  type AnalysisRange,
  type PortfolioAnalysisService,
} from "../analysis.js";
import { setNoStore } from "../auth.js";
import type { HistoricalPortfolioBackfill } from "../backfill.js";
import type { PortfolioBacktestService } from "../backtest.js";
import {
  isHistoryDate,
  type HistoryCurrency,
  type HistoryRange,
  type PortfolioHistoryStore,
} from "../history.js";
import type { BacktestService } from "../services/backtest-service.js";
import { TossApiError, type TossClient } from "../toss.js";
import { parseBacktestPayload } from "./backtest-payload.js";
import { sendBacktestError } from "./reports.js";

export type PortfolioDataRouteDependencies = {
  authenticate: RequestHandler;
  toss: TossClient;
  historyStore: PortfolioHistoryStore;
  historicalBackfill: HistoricalPortfolioBackfill;
  portfolioAnalysis: PortfolioAnalysisService;
  portfolioBacktest: PortfolioBacktestService;
  backtests: BacktestService;
  ownerSubject?: string;
};

function requestedAccount(request: Request): string {
  const account = typeof request.query.account === "string"
    ? request.query.account
    : typeof request.body?.account === "string"
      ? request.body.account
      : "";
  return account.trim();
}

export function createPortfolioDataRouter({
  authenticate,
  toss,
  historyStore,
  historicalBackfill,
  portfolioAnalysis,
  portfolioBacktest,
  backtests,
  ownerSubject = "owner",
}: PortfolioDataRouteDependencies): Router {
  const router = Router();

  router.get("/api/portfolio/history", authenticate, async (request, response) => {
    setNoStore(response);
    const accountId = typeof request.query.account === "string" ? request.query.account.trim() : "";
    const currency = request.query.currency === "USD"
      ? "USD"
      : request.query.currency === "KRW"
        ? "KRW"
        : request.query.currency === "ALL"
          ? "ALL"
          : undefined;
    const range = ["7d", "30d", "90d", "all"].includes(String(request.query.range))
      ? request.query.range as HistoryRange
      : undefined;
    const fromDate = typeof request.query.from === "string" ? request.query.from.trim() : "";
    const toDate = typeof request.query.to === "string" ? request.query.to.trim() : "";
    const hasCustomRange = Boolean(fromDate || toDate);
    const validCustomRange = !hasCustomRange
      || (isHistoryDate(fromDate) && isHistoryDate(toDate) && fromDate <= toDate);

    if (!accountId || !currency || !range || !validCustomRange) {
      response.status(400).json({
        error: {
          code: "invalid-history-query",
          message: "account, currency(ALL/KRW/USD), range와 from/to(YYYY-MM-DD) 값을 확인해 주세요.",
        },
      });
      return;
    }

    try {
      response.json(currency === "ALL"
        ? await portfolioAnalysis.getCombinedHistory({
            accountId,
            range,
            ...(hasCustomRange ? { fromDate, toDate } : {}),
          })
        : await historyStore.getHistory(
            accountId,
            currency as HistoryCurrency,
            range,
            new Date(),
            hasCustomRange ? { from: fromDate, to: toDate } : undefined,
          ));
    } catch (error) {
      console.error("[history] 일별 기록 조회 실패:", error instanceof Error ? error.message : error);
      response.status(500).json({
        error: { code: "history-unavailable", message: "일별 포트폴리오 기록을 불러오지 못했습니다." },
      });
    }
  });

  router.get("/api/portfolio/history/status", authenticate, async (request, response) => {
    setNoStore(response);
    const accountId = requestedAccount(request);
    if (!accountId || accountId.length > 128) {
      response.status(400).json({
        error: { code: "invalid-account", message: "조회할 계좌를 선택해 주세요." },
      });
      return;
    }
    response.json(await historicalBackfill.getStatus(accountId));
  });

  router.post("/api/portfolio/history/backfill", authenticate, async (request, response) => {
    setNoStore(response);
    const accountId = requestedAccount(request);
    if (!accountId || accountId.length > 128) {
      response.status(400).json({
        error: { code: "invalid-account", message: "동기화할 계좌를 선택해 주세요." },
      });
      return;
    }
    try {
      const accounts = await toss.getAccounts();
      if (!accounts.some((account) => account.id === accountId)) {
        response.status(404).json({
          error: { code: "invalid-account", message: "선택한 계좌를 찾을 수 없습니다." },
        });
        return;
      }
      const started = historicalBackfill.start(accountId, true);
      response.status(202).json({
        started,
        status: await historicalBackfill.getStatus(accountId),
      });
    } catch (error) {
      const message = error instanceof TossApiError
        ? error.message
        : "과거 데이터 동기화를 시작하지 못했습니다.";
      response.status(502).json({ error: { code: "backfill-unavailable", message } });
    }
  });

  router.get("/api/portfolio/analysis", authenticate, async (request, response) => {
    setNoStore(response);
    const accountId = requestedAccount(request);
    const range = ["30d", "90d", "1y", "all"].includes(String(request.query.range))
      ? request.query.range as AnalysisRange
      : undefined;
    const fromQuery = typeof request.query.from === "string" ? request.query.from.trim() : "";
    const toQuery = typeof request.query.to === "string" ? request.query.to.trim() : "";
    const hasCustomRange = Boolean(fromQuery || toQuery);
    const riskFreeRateText = typeof request.query.riskFreeRate === "string"
      ? request.query.riskFreeRate.trim()
      : "0";
    const riskFreeRatePercent = Number(riskFreeRateText);
    const validCustomRange = !hasCustomRange
      || (isHistoryDate(fromQuery) && isHistoryDate(toQuery) && fromQuery <= toQuery);

    if (!accountId || accountId.length > 128 || !range || !validCustomRange
      || !Number.isFinite(riskFreeRatePercent) || riskFreeRatePercent < -10
      || riskFreeRatePercent > 50) {
      response.status(400).json({
        error: {
          code: "invalid-analysis-query",
          message: "account, range와 from/to(YYYY-MM-DD) 값을 확인해 주세요.",
        },
      });
      return;
    }

    try {
      const benchmarkKeys = parseBenchmarkKeys(request.query.benchmarks);
      const today = analysisToday();
      const firstTradeDate = (await historyStore.getBackfillStatus(accountId)).firstTradeDate;
      const fromDate = hasCustomRange ? fromQuery : analysisStartDate(range, today, firstTradeDate);
      const toDate = hasCustomRange ? toQuery : today;
      response.json(await portfolioAnalysis.getAnalysis({
        accountId,
        range,
        fromDate,
        toDate,
        benchmarkKeys,
        riskFreeRatePercent,
      }));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("지원하는 비교 지수")) {
        response.status(400).json({ error: { code: "invalid-benchmark", message: error.message } });
        return;
      }
      console.error("[analysis] 분석 데이터 조회 실패:", error instanceof Error ? error.message : error);
      response.status(502).json({
        error: { code: "analysis-unavailable", message: "포트폴리오 분석 데이터를 불러오지 못했습니다." },
      });
    }
  });

  router.get("/api/portfolio/backtest/instruments", authenticate, async (request, response) => {
    setNoStore(response);
    const symbols = typeof request.query.symbols === "string"
      ? request.query.symbols.split(",").map((symbol) => symbol.trim()).filter(Boolean)
      : [];
    try {
      response.json({ instruments: await portfolioBacktest.resolveInstruments(symbols) });
    } catch (error) {
      sendBacktestError(response, error);
    }
  });

  router.get("/api/portfolio/backtest/current", authenticate, async (request, response) => {
    setNoStore(response);
    const accountId = requestedAccount(request);
    if (!accountId || accountId.length > 128) {
      response.status(400).json({
        error: { code: "invalid-account", message: "조회할 계좌를 선택해 주세요." },
      });
      return;
    }
    try {
      response.json(await portfolioBacktest.currentPortfolio(accountId));
    } catch (error) {
      sendBacktestError(response, error);
    }
  });

  router.post("/api/portfolio/backtest", authenticate, async (request, response) => {
    setNoStore(response);
    const payload = parseBacktestPayload(request.body);
    try {
      const completed = await backtests.runRawWithMetadata({
        ownerSubject,
        request: payload,
      });
      response.json({
        ...completed.result,
        runId: completed.runId,
        reused: completed.reused,
      });
    } catch (error) {
      sendBacktestError(response, error);
    }
  });

  return router;
}
