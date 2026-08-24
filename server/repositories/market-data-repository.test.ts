import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RelationalDatabase } from "../database.js";
import { MarketDataRepository } from "./market-data-repository.js";

describe("MarketDataRepository", () => {
  it("시장 데이터 revision을 한 snapshot과 한 DB 왕복으로 계산한다", async () => {
    const query = vi.fn().mockResolvedValue([{
      candle_count: "12",
      candle_revision: "1700000000000",
      volume_sum: "3456.5",
      fx_count: "4",
      fx_revision: "1700000000100",
    }]);
    const database = {
      query,
      run: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    } as unknown as RelationalDatabase;
    const repository = new MarketDataRepository(database);

    const revision = await repository.dataRevision();

    expect(revision).toBe(createHash("sha256")
      .update("12:1700000000000:3456.5:4:1700000000100")
      .digest("hex"));
    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).toContain("CROSS JOIN");
  });
});
