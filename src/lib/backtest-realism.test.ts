import { describe, expect, it } from "vitest";
import { parseTargetWeightScheduleJson } from "./backtest-realism";

const options = { assetSymbols: ["AAPL", "005930"], startDate: "2024-01-01", endDate: "2024-12-31" };

describe("parseTargetWeightScheduleJson", () => {
  it("빈 입력을 하위 호환 빈 일정으로 처리한다", () => {
    expect(parseTargetWeightScheduleJson("", options)).toEqual({ value: [] });
  });

  it("종목 심볼을 정규화하고 선택 메타데이터를 보존한다", () => {
    const result = parseTargetWeightScheduleJson(JSON.stringify([{
      date: "2024-06-03",
      weights: { aapl: 45, "005930": 50 },
      cashTargetPercent: 5,
      regime: "risk-off",
      action: "defensive",
    }]), options);
    expect(result).toEqual({ value: [{
      date: "2024-06-03",
      weights: { AAPL: 45, "005930": 50 },
      cashTargetPercent: 5,
      regime: "risk-off",
      action: "defensive",
    }] });
  });

  it("구성 종목 누락과 비중 합계 오류를 거부한다", () => {
    expect(parseTargetWeightScheduleJson('[{"date":"2024-06-03","weights":{"AAPL":100}}]', options).error)
      .toContain("구성 종목");
    expect(parseTargetWeightScheduleJson('[{"date":"2024-06-03","weights":{"AAPL":40,"005930":40}}]', options).error)
      .toContain("100%");
    expect(parseTargetWeightScheduleJson('[{"date":"2024-06-03","weights":{"AAPL":25,"aapl":25,"005930":50}}]', options).error)
      .toContain("중복 종목");
  });

  it("기간 밖 날짜와 중복 날짜를 거부한다", () => {
    expect(parseTargetWeightScheduleJson('[{"date":"2025-01-01","weights":{"AAPL":50,"005930":50}}]', options).error)
      .toContain("기간 안");
    expect(parseTargetWeightScheduleJson('[{"date":"2024-06-03","weights":{"AAPL":50,"005930":50}},{"date":"2024-06-03","weights":{"AAPL":50,"005930":50}}]', options).error)
      .toContain("중복");
  });
});
