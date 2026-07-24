import { Router, type RequestHandler } from "express";
import { setNoStore } from "../auth.js";
import type { Portfolio } from "../toss.js";
import { TossApiError } from "../toss.js";

export type PortfolioRouteDependencies = {
  authenticate: RequestHandler;
  getPortfolio: (account?: string, force?: boolean) => Promise<Portfolio>;
  recordPortfolio: (portfolio: Portfolio) => Promise<void>;
  logError?: (scope: "history" | "portfolio", error: unknown) => void;
};

function defaultLogError(scope: "history" | "portfolio", error: unknown): void {
  const message = error instanceof Error ? error.message : error;
  console.error(scope === "history" ? "[history] 일별 스냅샷 저장 실패:" : "[portfolio]", message);
}

export function createPortfolioRouter(dependencies: PortfolioRouteDependencies): Router {
  const router = Router();
  const logError = dependencies.logError ?? defaultLogError;

  router.get("/api/portfolio", dependencies.authenticate, async (request, response) => {
    setNoStore(response);
    try {
      const account = typeof request.query.account === "string" ? request.query.account : undefined;
      const force = request.query.refresh === "1";
      const portfolio = await dependencies.getPortfolio(account, force);
      if (request.query.snapshot !== "0") {
        try {
          await dependencies.recordPortfolio(portfolio);
        } catch (historyError) {
          logError("history", historyError);
        }
      }
      response.json(portfolio);
    } catch (error) {
      if (error instanceof TossApiError) {
        const status = error.status === 400 || error.status === 404 || error.status === 429
          ? error.status
          : 502;
        response.status(status).json({
          error: {
            code: error.code,
            message: error.message,
            ...(error.requestId ? { requestId: error.requestId } : {}),
          },
        });
        return;
      }
      const message = error instanceof Error && error.name === "TimeoutError"
        ? "토스증권 응답 시간이 초과되었습니다."
        : "포트폴리오를 불러오는 중 예기치 못한 오류가 발생했습니다.";
      logError("portfolio", error);
      response.status(502).json({ error: { code: "portfolio-unavailable", message } });
    }
  });

  return router;
}
