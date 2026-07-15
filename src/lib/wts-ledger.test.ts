import { describe, expect, it } from "vitest";
import { parseWtsLedger } from "@/lib/wts-ledger";

const fixture = `
샘플전자 12주
09:14 ㅣ 구매
-120,600원
879,400원

7.14

예금주A
15:10 ㅣ 이체입금
300,000원
1,000,000원

1.3

달러로 환전
11:20 ㅣ 환전원화출금
-135,200원
700,000원

12.29

샘플바이오 3주
10:02 ㅣ 판매
75,300원
775,300원
`;

describe("parseWtsLedger", () => {
  it("주문·이체·환전을 추출하고 연도 경계를 역순으로 추론한다", () => {
    const result = parseWtsLedger(fixture, { baseYear: 2026, leadingDate: "2026-07-15" });
    expect(result.unresolvedEntries).toBe(0);
    expect(result.entries).toHaveLength(4);
    expect(result.entries[0]).toMatchObject({
      date: "2026-07-15",
      title: "샘플전자 12주",
      instrumentName: "샘플전자",
      quantity: 12,
      kind: "BUY",
      amount: -120600,
      balance: 879400,
    });
    expect(result.entries[1]).toMatchObject({ date: "2026-07-14", kind: "DEPOSIT" });
    expect(result.entries[2]).toMatchObject({ date: "2026-01-03", kind: "EXCHANGE_OUT" });
    expect(result.entries[3]).toMatchObject({ date: "2025-12-29", kind: "SELL" });
  });

  it("첫 날짜 머리글보다 앞선 거래는 날짜 지정 전까지 보류한다", () => {
    const unresolved = parseWtsLedger(fixture, { baseYear: 2026 });
    expect(unresolved.unresolvedEntries).toBe(1);
    expect(unresolved.entries).toHaveLength(3);
  });

  it("파이프 문자와 달러 표시를 허용한다", () => {
    const result = parseWtsLedger(`2026.7.1\n미국주식 1주\n09:01 | 구매\n-$10.50\n$89.50`, { baseYear: 2026 });
    expect(result.entries[0]).toMatchObject({ currency: "USD", amount: -10.5, balance: 89.5 });
  });
});
