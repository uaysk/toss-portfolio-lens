import { describe, expect, it } from "vitest";
import { layoutAreaLabels } from "@/lib/allocation-labels";

const scale = (value: number) => 300 - value;

describe("layoutAreaLabels", () => {
  it("keeps roomy segments inside and excludes zero-weight series", () => {
    const labels = layoutAreaLabels([
      { key: "large", name: "큰 종목", value: 60 },
      { key: "zero", name: "비중 없음", value: 0 },
      { key: "small", name: "작은 종목", value: 8 },
    ], { scale, plotTop: 0, plotBottom: 300 });

    expect(labels.map((label) => label.key)).toEqual(["large", "small"]);
    expect(labels[0]).toMatchObject({ placement: "inside", anchorY: 270, segmentHeight: 60 });
    expect(labels[1]).toMatchObject({ placement: "callout", anchorY: 236, segmentHeight: 8 });
  });

  it("separates callout labels while keeping them inside the plot", () => {
    const labels = layoutAreaLabels([
      { key: "a", name: "A", value: 4 },
      { key: "b", name: "B", value: 4 },
      { key: "c", name: "C", value: 4 },
    ], { scale, plotTop: 200, plotBottom: 300, calloutGap: 15 });

    expect(labels.every((label) => label.placement === "callout")).toBe(true);
    const positions = labels.map((label) => label.labelY).sort((a, b) => a - b);
    expect(positions[0]).toBeGreaterThanOrEqual(208);
    expect(positions.at(-1)).toBeLessThanOrEqual(292);
    expect(positions[1] - positions[0]).toBeGreaterThanOrEqual(15);
    expect(positions[2] - positions[1]).toBeGreaterThanOrEqual(15);
  });
});
