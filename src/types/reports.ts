import type { PortfolioAnalysis } from "./analysis";
import type { BacktestResult } from "./backtest";

export type ReportStance = "strong" | "balanced" | "cautious" | "high-risk";

export type ReportNarrative = {
  score: number;
  stance: ReportStance;
  summary: string;
  strengths: [string, string, string];
  risks: [string, string, string];
  actions: [string, string, string];
  methodology: string;
};

type ReportBase = {
  schemaVersion: 1;
  templateVersion: "portfolio-report-v1";
  id: string;
  createdAt: string;
  title: string;
  period: { from: string; to: string };
  narrative: ReportNarrative;
};

export type AnalysisReport = ReportBase & {
  kind: "analysis";
  data: Omit<PortfolioAnalysis, "accountId">;
};

export type BacktestReport = ReportBase & {
  kind: "backtest";
  data: BacktestResult;
};

export type StoredReport = AnalysisReport | BacktestReport;

export type ReportCreateResponse = {
  id: string;
  url: string;
  createdAt: string;
  storage: "local" | "s3";
};
