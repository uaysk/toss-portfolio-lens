import { lazy, type ReactNode } from "react";
import {
  BarChart3,
  Bot,
  CandlestickChart,
  FlaskConical,
  LayoutDashboard,
  LibraryBig,
  Sparkles,
  TimerReset,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { TechnicalStrategyHandoff } from "@/lib/technical-strategy";
import type { Portfolio, Theme } from "@/types";

const PortfolioAnalysisView = lazy(() => import("@/components/portfolio-analysis").then((module) => ({ default: module.PortfolioAnalysisView })));
const PortfolioBacktestView = lazy(() => import("@/components/portfolio-backtest").then((module) => ({ default: module.PortfolioBacktestView })));
const ResearchLibrary = lazy(() => import("@/components/research-library").then((module) => ({ default: module.ResearchLibrary })));
const TechnicalAnalysisView = lazy(() => import("@/components/technical-analysis").then((module) => ({ default: module.TechnicalAnalysisView })));
const ScalpingAssistant = lazy(() => import("@/components/scalping-assistant").then((module) => ({ default: module.ScalpingAssistant })));
const AiSimulation = lazy(() => import("@/components/ai-simulation").then((module) => ({ default: module.AiSimulation })));

export type DashboardViewContentContext = {
  portfolio: Portfolio;
  theme: Theme;
  onUnauthorized: () => void;
  technicalStrategyHandoff?: TechnicalStrategyHandoff;
  onOpenTechnicalBacktest: (handoff: TechnicalStrategyHandoff) => void;
  onTechnicalStrategyHandoffConsumed: () => void;
};

type DashboardViewDefinitionShape = {
  value: string;
  hash: `#${string}`;
  sidebarLabel: string;
  mobileLabel: string;
  eyebrow: string;
  title: string;
  loadingLabel: string;
  icon: LucideIcon;
  navigation: {
    desktop: boolean;
    mobile: boolean;
  };
  content:
    | { kind: "overview" }
    | {
      kind: "lazy";
      render: (context: DashboardViewContentContext) => ReactNode;
    };
};

export const DASHBOARD_VIEW_REGISTRY = [
  {
    value: "overview",
    hash: "#overview",
    sidebarLabel: "포트폴리오",
    mobileLabel: "포트폴리오",
    eyebrow: "PORTFOLIO OVERVIEW",
    title: "안녕하세요.",
    loadingLabel: "포트폴리오 화면을 불러오는 중",
    icon: LayoutDashboard,
    navigation: { desktop: true, mobile: true },
    content: { kind: "overview" },
  },
  {
    value: "analysis",
    hash: "#analysis",
    sidebarLabel: "포트폴리오 분석",
    mobileLabel: "분석",
    eyebrow: "PORTFOLIO ANALYSIS",
    title: "포트폴리오 분석",
    loadingLabel: "포트폴리오 분석 화면을 불러오는 중",
    icon: BarChart3,
    navigation: { desktop: true, mobile: true },
    content: {
      kind: "lazy",
      render: ({ portfolio, theme, onUnauthorized }) => (
        <PortfolioAnalysisView
          key={portfolio.selectedAccountId}
          portfolio={portfolio}
          theme={theme}
          onUnauthorized={onUnauthorized}
        />
      ),
    },
  },
  {
    value: "technical",
    hash: "#technical-analysis",
    sidebarLabel: "기술적 분석",
    mobileLabel: "기술 분석",
    eyebrow: "TECHNICAL ANALYSIS",
    title: "기술적 분석",
    loadingLabel: "기술적 분석 화면을 불러오는 중",
    icon: CandlestickChart,
    navigation: { desktop: true, mobile: true },
    content: {
      kind: "lazy",
      render: ({ portfolio, theme, onUnauthorized, onOpenTechnicalBacktest }) => (
        <TechnicalAnalysisView
          key={`${portfolio.selectedAccountId}:technical`}
          portfolio={portfolio}
          theme={theme}
          onUnauthorized={onUnauthorized}
          onOpenTechnicalBacktest={onOpenTechnicalBacktest}
        />
      ),
    },
  },
  {
    value: "scalping",
    hash: "#scalping-assistant",
    sidebarLabel: "단타 보조",
    mobileLabel: "단타 보조",
    eyebrow: "SCALPING ASSISTANT",
    title: "단타 보조",
    loadingLabel: "단타 보조 화면을 불러오는 중",
    icon: TimerReset,
    navigation: { desktop: true, mobile: true },
    content: {
      kind: "lazy",
      render: ({ portfolio, theme, onUnauthorized }) => (
        <ScalpingAssistant
          key={`${portfolio.selectedAccountId}:scalping`}
          portfolio={portfolio}
          theme={theme}
          onUnauthorized={onUnauthorized}
        />
      ),
    },
  },
  {
    value: "simulation",
    hash: "#simulation",
    sidebarLabel: "시뮬레이션",
    mobileLabel: "시뮬레이션",
    eyebrow: "AI PAPER SIMULATION",
    title: "시뮬레이션",
    loadingLabel: "시뮬레이션 화면을 불러오는 중",
    icon: Bot,
    navigation: { desktop: true, mobile: true },
    content: {
      kind: "lazy",
      render: ({ portfolio, onUnauthorized }) => (
        <AiSimulation
          key={`${portfolio.selectedAccountId}:simulation`}
          onUnauthorized={onUnauthorized}
        />
      ),
    },
  },
  {
    value: "backtest",
    hash: "#backtest",
    sidebarLabel: "백테스트",
    mobileLabel: "백테스트",
    eyebrow: "PORTFOLIO BACKTEST",
    title: "백테스트",
    loadingLabel: "백테스트 화면을 불러오는 중",
    icon: FlaskConical,
    navigation: { desktop: true, mobile: true },
    content: {
      kind: "lazy",
      render: ({
        portfolio,
        theme,
        onUnauthorized,
        technicalStrategyHandoff,
        onTechnicalStrategyHandoffConsumed,
      }) => (
        <PortfolioBacktestView
          key={`${portfolio.selectedAccountId}:backtest`}
          portfolio={portfolio}
          theme={theme}
          onUnauthorized={onUnauthorized}
          mode="backtest"
          technicalStrategyHandoff={
            technicalStrategyHandoff?.accountId === portfolio.selectedAccountId
              ? technicalStrategyHandoff
              : undefined
          }
          onTechnicalStrategyHandoffConsumed={onTechnicalStrategyHandoffConsumed}
        />
      ),
    },
  },
  {
    value: "optimization",
    hash: "#optimization",
    sidebarLabel: "최적화",
    mobileLabel: "최적화",
    eyebrow: "PORTFOLIO OPTIMIZATION",
    title: "포트폴리오 최적화",
    loadingLabel: "최적화 화면을 불러오는 중",
    icon: Sparkles,
    navigation: { desktop: true, mobile: true },
    content: {
      kind: "lazy",
      render: ({ portfolio, theme, onUnauthorized }) => (
        <PortfolioBacktestView
          key={`${portfolio.selectedAccountId}:optimization`}
          portfolio={portfolio}
          theme={theme}
          onUnauthorized={onUnauthorized}
          mode="optimization"
        />
      ),
    },
  },
  {
    value: "library",
    hash: "#library",
    sidebarLabel: "실행·프리셋",
    mobileLabel: "실행·프리셋",
    eyebrow: "RUNS & PRESETS",
    title: "실행·프리셋",
    loadingLabel: "실행·프리셋 화면을 불러오는 중",
    icon: LibraryBig,
    navigation: { desktop: true, mobile: true },
    content: {
      kind: "lazy",
      render: ({ portfolio, theme, onUnauthorized }) => (
        <ResearchLibrary
          key={`${portfolio.selectedAccountId}:library`}
          portfolio={portfolio}
          theme={theme}
          onUnauthorized={onUnauthorized}
        />
      ),
    },
  },
] as const satisfies readonly DashboardViewDefinitionShape[];

export type DashboardViewDefinition = (typeof DASHBOARD_VIEW_REGISTRY)[number];
export type DashboardView = DashboardViewDefinition["value"];

const definitionsByView = new Map<DashboardView, DashboardViewDefinition>(
  DASHBOARD_VIEW_REGISTRY.map((definition) => [definition.value, definition] as const),
);

export function dashboardViewMetadata(view: DashboardView): DashboardViewDefinition {
  return definitionsByView.get(view) ?? DASHBOARD_VIEW_REGISTRY[0];
}
