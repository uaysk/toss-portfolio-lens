import { describe, expect, it } from "vitest";
import {
  TOSS_SIMULATION_COST_PROFILE_VERSION,
  calculateBrokerExecutionCharges,
  defaultSimulationCostsForMarket,
  estimatedSellRegulatoryBps,
  getTossSimulationCostProfile,
} from "./cost-profile.js";

describe("Toss Securities simulation cost profiles", () => {
  it("publishes market-specific, versioned defaults", () => {
    expect(defaultSimulationCostsForMarket("KR")).toEqual({
      commissionBpsPerSide: 1.5,
      taxBpsOnExit: 20,
      spreadBpsRoundTrip: 5,
      slippageBpsPerSide: 2,
    });
    expect(defaultSimulationCostsForMarket("US")).toEqual({
      commissionBpsPerSide: 10,
      taxBpsOnExit: 0,
      spreadBpsRoundTrip: 5,
      slippageBpsPerSide: 2,
    });
    expect(getTossSimulationCostProfile("US")).toMatchObject({
      profileVersion: TOSS_SIMULATION_COST_PROFILE_VERSION,
      commissionFreeGrossAmountMaximum: 10,
      sellRegulatoryBps: 0.206,
      sellRegulatoryFeePerShare: 0.000195,
      sellRegulatoryFeeMaximum: 9.79,
      fxConversionIncluded: false,
    });
  });

  it("waives the US broker commission at USD 10 and still charges sell regulatory fees", () => {
    const profile = getTossSimulationCostProfile("US");
    const costs = defaultSimulationCostsForMarket("US");
    expect(calculateBrokerExecutionCharges(profile, {
      side: "buy",
      grossAmount: 10,
      quantity: 2,
      costs,
    })).toMatchObject({
      commission: 0,
      exitTax: 0,
      regulatoryFee: 0,
      commissionWaived: true,
    });
    const sell = calculateBrokerExecutionCharges(profile, {
      side: "sell",
      grossAmount: 1_000,
      quantity: 20,
      costs,
    });
    expect(sell.commission).toBeCloseTo(1);
    expect(sell.exitTax).toBe(0);
    expect(sell.regulatoryFee).toBeCloseTo(0.0245);
    expect(sell.total).toBeCloseTo(1.0245);
  });

  it("caps FINRA TAF and expresses regulatory charges as an estimated rate", () => {
    const profile = getTossSimulationCostProfile("US");
    const sell = calculateBrokerExecutionCharges(profile, {
      side: "sell",
      grossAmount: 1_000_000,
      quantity: 100_000,
      costs: defaultSimulationCostsForMarket("US"),
    });
    expect(sell.regulatoryFee).toBeCloseTo(30.39);
    expect(estimatedSellRegulatoryBps(profile, {
      executionPrice: 10,
      grossAmount: 1_000_000,
    })).toBeCloseTo(0.3039);
  });
});
