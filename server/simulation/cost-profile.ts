export const TOSS_SIMULATION_COST_PROFILE_VERSION =
  "toss-securities-simulation-costs/v1" as const;

export type SimulationCostMarket = "KR" | "US";

export type SimulationCostSource = {
  label: string;
  url: string;
};

export type SimulationCostAssumptions = {
  commissionBpsPerSide: number;
  taxBpsOnExit: number;
  spreadBpsRoundTrip: number;
  slippageBpsPerSide: number;
};

export type TossSimulationCostProfile = {
  profileVersion: typeof TOSS_SIMULATION_COST_PROFILE_VERSION;
  profileId: string;
  broker: "Toss Securities";
  marketCountry: SimulationCostMarket;
  currency: "KRW" | "USD";
  venue: "KRX" | "US";
  effectiveFrom: string;
  verifiedAt: string;
  commissionBpsPerSide: number;
  commissionFreeGrossAmountMaximum: number | null;
  sellTaxBps: number;
  sellRegulatoryBps: number;
  sellRegulatoryFeePerShare: number;
  sellRegulatoryFeeMaximum: number | null;
  spreadBpsRoundTrip: number;
  slippageBpsPerSide: number;
  fxConversionIncluded: false;
  alternativeVenues: readonly {
    venue: string;
    commissionBpsPerSide: number;
  }[];
  scopeNotes: readonly string[];
  sources: readonly SimulationCostSource[];
};

export type BrokerExecutionChargeInput = {
  side: "buy" | "sell";
  grossAmount: number;
  quantity: number;
  costs: Pick<SimulationCostAssumptions, "commissionBpsPerSide" | "taxBpsOnExit">;
};

export type BrokerExecutionCharges = {
  commission: number;
  exitTax: number;
  regulatoryFee: number;
  total: number;
  commissionWaived: boolean;
};

const COMMON_MARKET_IMPACT_DEFAULTS = {
  spreadBpsRoundTrip: 5,
  slippageBpsPerSide: 2,
} as const;

const COST_PROFILES: Readonly<Record<SimulationCostMarket, TossSimulationCostProfile>> =
  Object.freeze({
    KR: Object.freeze({
      profileVersion: TOSS_SIMULATION_COST_PROFILE_VERSION,
      profileId: "toss-kr-krx-equity-2026",
      broker: "Toss Securities",
      marketCountry: "KR",
      currency: "KRW",
      venue: "KRX",
      effectiveFrom: "2026-01-01",
      verifiedAt: "2026-07-25",
      commissionBpsPerSide: 1.5,
      commissionFreeGrossAmountMaximum: null,
      sellTaxBps: 20,
      sellRegulatoryBps: 0,
      sellRegulatoryFeePerShare: 0,
      sellRegulatoryFeeMaximum: null,
      ...COMMON_MARKET_IMPACT_DEFAULTS,
      fxConversionIncluded: false,
      alternativeVenues: Object.freeze([
        Object.freeze({ venue: "NXT", commissionBpsPerSide: 1.4 }),
      ]),
      scopeNotes: Object.freeze([
        "KRX 일반 상장주식 기본값입니다.",
        "KOSPI는 증권거래세 5bps와 농어촌특별세 15bps, KOSDAQ은 증권거래세 20bps를 매도 시 반영합니다.",
        "ETF·ETN·ELW와 비상장·장외 상품은 과세 방식이 달라 이 기본 세율을 그대로 적용하지 않을 수 있습니다.",
      ]),
      sources: Object.freeze([
        Object.freeze({
          label: "토스증권 Open API 거래 수수료",
          url: "https://home.tossinvest.com/ko/open-api",
        }),
        Object.freeze({
          label: "국가법령정보센터 증권거래세·농어촌특별세",
          url: "https://www.law.go.kr/lsLinkCommonInfo.do?chrClsCd=010202&lspttninfSeq=64014",
        }),
      ]),
    }),
    US: Object.freeze({
      profileVersion: TOSS_SIMULATION_COST_PROFILE_VERSION,
      profileId: "toss-us-equity-2026",
      broker: "Toss Securities",
      marketCountry: "US",
      currency: "USD",
      venue: "US",
      effectiveFrom: "2026-04-04",
      verifiedAt: "2026-07-25",
      commissionBpsPerSide: 10,
      commissionFreeGrossAmountMaximum: 10,
      sellTaxBps: 0,
      sellRegulatoryBps: 0.206,
      sellRegulatoryFeePerShare: 0.000195,
      sellRegulatoryFeeMaximum: 9.79,
      ...COMMON_MARKET_IMPACT_DEFAULTS,
      fxConversionIncluded: false,
      alternativeVenues: Object.freeze([]),
      scopeNotes: Object.freeze([
        "미국 주식·ETF 온라인 거래 기본값이며 체결금액이 USD 10 이하인 주문은 토스증권 수수료를 0으로 계산합니다.",
        "매도 시 SEC Section 31 fee와 FINRA TAF를 별도 계산합니다.",
        "시뮬레이션 원장이 USD 기준이므로 원화 환전 비용·환율 스프레드·환전 우대는 포함하지 않습니다.",
      ]),
      sources: Object.freeze([
        Object.freeze({
          label: "토스증권 Open API 거래 수수료",
          url: "https://home.tossinvest.com/ko/open-api",
        }),
        Object.freeze({
          label: "SEC FY 2026 Section 31 fee rate advisory",
          url: "https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2",
        }),
        Object.freeze({
          label: "FINRA 2026 Trading Activity Fee schedule",
          url: "https://www.finra.org/rules-guidance/rule-filings/sr-finra-2024-019/fee-adjustment-schedule",
        }),
      ]),
    }),
  });

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number.`);
  }
  return value;
}

export function getTossSimulationCostProfile(
  marketCountry: SimulationCostMarket,
): TossSimulationCostProfile {
  return COST_PROFILES[marketCountry];
}

export function defaultSimulationCostsForMarket(
  marketCountry: SimulationCostMarket,
): SimulationCostAssumptions {
  const profile = getTossSimulationCostProfile(marketCountry);
  return {
    commissionBpsPerSide: profile.commissionBpsPerSide,
    taxBpsOnExit: profile.sellTaxBps,
    spreadBpsRoundTrip: profile.spreadBpsRoundTrip,
    slippageBpsPerSide: profile.slippageBpsPerSide,
  };
}

export function calculateBrokerExecutionCharges(
  profile: TossSimulationCostProfile,
  input: BrokerExecutionChargeInput,
): BrokerExecutionCharges {
  const grossAmount = finiteNonNegative(input.grossAmount, "grossAmount");
  const quantity = finiteNonNegative(input.quantity, "quantity");
  const commissionBps = finiteNonNegative(
    input.costs.commissionBpsPerSide,
    "commissionBpsPerSide",
  );
  const exitTaxBps = finiteNonNegative(input.costs.taxBpsOnExit, "taxBpsOnExit");
  const commissionWaived = profile.commissionFreeGrossAmountMaximum !== null
    && grossAmount <= profile.commissionFreeGrossAmountMaximum;
  const commission = commissionWaived ? 0 : grossAmount * commissionBps / 10_000;
  const exitTax = input.side === "sell" ? grossAmount * exitTaxBps / 10_000 : 0;
  const uncappedPerShareFee = quantity * profile.sellRegulatoryFeePerShare;
  const perShareFee = profile.sellRegulatoryFeeMaximum === null
    ? uncappedPerShareFee
    : Math.min(uncappedPerShareFee, profile.sellRegulatoryFeeMaximum);
  const regulatoryFee = input.side === "sell"
    ? grossAmount * profile.sellRegulatoryBps / 10_000 + perShareFee
    : 0;
  return {
    commission,
    exitTax,
    regulatoryFee,
    total: commission + exitTax + regulatoryFee,
    commissionWaived,
  };
}

export function estimatedSellRegulatoryBps(
  profile: TossSimulationCostProfile,
  input: {
    executionPrice?: number;
    grossAmount?: number;
  } = {},
): number {
  const executionPrice = input.executionPrice;
  const grossAmount = input.grossAmount;
  let perShareBps = 0;
  if (executionPrice !== undefined && Number.isFinite(executionPrice) && executionPrice > 0) {
    perShareBps = profile.sellRegulatoryFeePerShare / executionPrice * 10_000;
    if (grossAmount !== undefined && Number.isFinite(grossAmount) && grossAmount > 0
      && profile.sellRegulatoryFeeMaximum !== null) {
      perShareBps = Math.min(
        perShareBps,
        profile.sellRegulatoryFeeMaximum / grossAmount * 10_000,
      );
    }
  }
  return profile.sellRegulatoryBps + perShareBps;
}
