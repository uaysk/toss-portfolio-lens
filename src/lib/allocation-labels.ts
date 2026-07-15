export type AreaLabelDatum = {
  key: string;
  name: string;
  value: number;
};

export type AreaLabelLayout = AreaLabelDatum & {
  anchorY: number;
  labelY: number;
  segmentHeight: number;
  placement: "inside" | "callout";
};

type LayoutOptions = {
  scale: (value: number) => number;
  plotTop: number;
  plotBottom: number;
  minimumInsideHeight?: number;
  calloutGap?: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function distributeCallouts(
  labels: AreaLabelLayout[],
  plotTop: number,
  plotBottom: number,
  requestedGap: number,
): AreaLabelLayout[] {
  if (!labels.length) return labels;

  const top = plotTop + 8;
  const bottom = plotBottom - 8;
  const ordered = [...labels].sort((a, b) => a.anchorY - b.anchorY);
  if (ordered.length === 1) {
    return [{ ...ordered[0], labelY: clamp(ordered[0].anchorY, top, bottom) }];
  }

  const gap = Math.min(requestedGap, Math.max(0, (bottom - top) / (ordered.length - 1)));
  const positions = ordered.map((label) => clamp(label.anchorY, top, bottom));

  for (let index = 1; index < positions.length; index += 1) {
    positions[index] = Math.max(positions[index], positions[index - 1] + gap);
  }

  const overflow = positions[positions.length - 1] - bottom;
  if (overflow > 0) {
    for (let index = 0; index < positions.length; index += 1) positions[index] -= overflow;
  }

  for (let index = positions.length - 2; index >= 0; index -= 1) {
    positions[index] = Math.min(positions[index], positions[index + 1] - gap);
  }

  const underflow = top - positions[0];
  if (underflow > 0) {
    for (let index = 0; index < positions.length; index += 1) positions[index] += underflow;
  }

  return ordered.map((label, index) => ({ ...label, labelY: positions[index] }));
}

export function layoutAreaLabels(
  data: AreaLabelDatum[],
  {
    scale,
    plotTop,
    plotBottom,
    minimumInsideHeight = 22,
    calloutGap = 15,
  }: LayoutOptions,
): AreaLabelLayout[] {
  let cumulativeValue = 0;
  const labels: AreaLabelLayout[] = [];

  for (const item of data) {
    if (!Number.isFinite(item.value) || item.value <= 0) continue;

    const bottomY = scale(cumulativeValue);
    cumulativeValue += item.value;
    const topY = scale(cumulativeValue);
    const anchorY = (topY + bottomY) / 2;
    const segmentHeight = Math.abs(bottomY - topY);

    labels.push({
      ...item,
      anchorY,
      labelY: anchorY,
      segmentHeight,
      placement: segmentHeight >= minimumInsideHeight ? "inside" : "callout",
    });
  }

  const callouts = distributeCallouts(
    labels.filter((label) => label.placement === "callout"),
    plotTop,
    plotBottom,
    calloutGap,
  );
  const calloutByKey = new Map(callouts.map((label) => [label.key, label]));

  return labels.map((label) => calloutByKey.get(label.key) ?? label);
}
