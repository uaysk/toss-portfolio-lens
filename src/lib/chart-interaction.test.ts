import { describe, expect, it, vi } from "vitest";
import {
  createAnimationFrameCoalescer,
  groupByNormalizedSymbol,
} from "./chart-interaction";

describe("chart interaction", () => {
  it("commits at most once per animation frame and keeps the latest pointer value", () => {
    let callback: FrameRequestCallback | undefined;
    const commit = vi.fn();
    const coalescer = createAnimationFrameCoalescer({
      request(next) {
        callback = next;
        return 7;
      },
      cancel: vi.fn(),
    }, commit);

    for (let index = 0; index < 20; index += 1) coalescer.schedule(index);
    expect(commit).not.toHaveBeenCalled();
    callback?.(16);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(19);
  });

  it("groups symbols once with normalized case", () => {
    const first = { symbol: "soxl", value: 1 };
    const second = { symbol: " SOXL ", value: 2 };
    const grouped = groupByNormalizedSymbol([first, second], (item) => item.symbol);

    expect(grouped.get("SOXL")).toEqual([first, second]);
  });
});
