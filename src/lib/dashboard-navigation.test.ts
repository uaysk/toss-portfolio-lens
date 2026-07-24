import { isValidElement, type ReactElement } from "react";
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
import { describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_VIEW_REGISTRY,
  type DashboardViewContentContext,
} from "./dashboard-view-registry";
import { dashboardHash, dashboardViewFromHash } from "./dashboard-navigation";
import type { TechnicalStrategyHandoff } from "@/lib/technical-strategy";
import type { Portfolio } from "@/types";

const expectedViews = [
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
    contentKind: "overview",
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
    contentKind: "lazy",
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
    contentKind: "lazy",
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
    contentKind: "lazy",
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
    contentKind: "lazy",
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
    contentKind: "lazy",
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
    contentKind: "lazy",
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
    contentKind: "lazy",
  },
] as const;

function registrySnapshot() {
  return DASHBOARD_VIEW_REGISTRY.map(({ content, ...definition }) => ({
    ...definition,
    contentKind: content.kind,
  }));
}

function lazyContent(
  value: Exclude<(typeof expectedViews)[number]["value"], "overview">,
  context: DashboardViewContentContext,
): ReactElement<Record<string, unknown>> {
  const definition = DASHBOARD_VIEW_REGISTRY.find((item) => item.value === value);
  if (!definition || definition.content.kind !== "lazy") throw new Error(`${value} lazy renderer를 찾지 못했습니다.`);
  const content = definition.content.render(context);
  if (!isValidElement(content)) throw new Error(`${value} renderer가 React element를 반환하지 않았습니다.`);
  return content as ReactElement<Record<string, unknown>>;
}

describe("dashboard navigation", () => {
  it("화면 순서와 hash, 표시 문구, icon, navigation visibility를 고정한다", () => {
    expect(registrySnapshot()).toEqual(expectedViews);
  });

  it("화면 value와 hash가 각각 유일하다", () => {
    expect(new Set(DASHBOARD_VIEW_REGISTRY.map(({ value }) => value)).size).toBe(DASHBOARD_VIEW_REGISTRY.length);
    expect(new Set(DASHBOARD_VIEW_REGISTRY.map(({ hash }) => hash)).size).toBe(DASHBOARD_VIEW_REGISTRY.length);
  });

  it.each(expectedViews)("$value 화면과 $hash hash를 왕복한다", ({ value, hash }) => {
    expect(dashboardHash(value)).toBe(hash);
    expect(dashboardViewFromHash(hash)).toBe(value);
  });

  it.each(["", "#unknown", "#history", "#allocation", "#holdings"])("%s hash는 포트폴리오 화면으로 되돌린다", (hash) => {
    expect(dashboardViewFromHash(hash)).toBe("overview");
  });

  it("lazy content renderer가 기존 key, mode, technical handoff를 보존한다", () => {
    const portfolio = { selectedAccountId: "account-1" } as Portfolio;
    const technicalStrategyHandoff = { accountId: "account-1" } as TechnicalStrategyHandoff;
    const context: DashboardViewContentContext = {
      portfolio,
      theme: "dark",
      onUnauthorized: vi.fn(),
      technicalStrategyHandoff,
      onOpenTechnicalBacktest: vi.fn(),
      onTechnicalStrategyHandoffConsumed: vi.fn(),
    };

    const analysis = lazyContent("analysis", context);
    const technical = lazyContent("technical", context);
    const scalping = lazyContent("scalping", context);
    const simulation = lazyContent("simulation", context);
    const backtest = lazyContent("backtest", context);
    const optimization = lazyContent("optimization", context);
    const library = lazyContent("library", context);

    expect(analysis.key).toBe("account-1");
    expect(technical.key).toBe("account-1:technical");
    expect(technical.props.onOpenTechnicalBacktest).toBe(context.onOpenTechnicalBacktest);
    expect(scalping.key).toBe("account-1:scalping");
    expect(simulation.key).toBe("account-1:simulation");
    expect(backtest.key).toBe("account-1:backtest");
    expect(backtest.props.mode).toBe("backtest");
    expect(backtest.props.technicalStrategyHandoff).toBe(technicalStrategyHandoff);
    expect(backtest.props.onTechnicalStrategyHandoffConsumed).toBe(context.onTechnicalStrategyHandoffConsumed);
    expect(optimization.key).toBe("account-1:optimization");
    expect(optimization.props.mode).toBe("optimization");
    expect(optimization.type).toBe(backtest.type);
    expect(library.key).toBe("account-1:library");

    const mismatchedHandoff = lazyContent("backtest", {
      ...context,
      technicalStrategyHandoff: { accountId: "other-account" } as TechnicalStrategyHandoff,
    });
    expect(mismatchedHandoff.props.technicalStrategyHandoff).toBeUndefined();
  });
});
