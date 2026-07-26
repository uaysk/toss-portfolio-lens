import type {
  ScalpingAnalysisInstrument,
  ScalpingRealtimeAnalysisResult,
  ScalpingWorkspaceResult,
} from "../scalping/api-contracts.js";

const MAX_CHART_BARS = 180;
const MAX_CHART_PATTERNS = 120;

type UnknownRecord = Record<string, unknown>;

export type SimulationChartPatternBias = "bullish" | "bearish" | "neutral";

export type SimulationChartPatternName =
  | "bullish_engulfing"
  | "bearish_engulfing"
  | "hammer"
  | "shooting_star"
  | "inside_bar"
  | "bullish_outside_bar"
  | "bearish_outside_bar"
  | "bullish_flag"
  | "bearish_flag"
  | "bullish_pennant"
  | "bearish_pennant"
  | "rising_wedge"
  | "falling_wedge"
  | "symmetric_triangle"
  | "ascending_triangle"
  | "descending_triangle"
  | "double_top"
  | "double_bottom"
  | "head_and_shoulders"
  | "inverse_head_and_shoulders"
  | "bullish_channel_breakout"
  | "bearish_channel_breakout";

export type SimulationChartPattern = {
  name: SimulationChartPatternName;
  bias: SimulationChartPatternBias;
  strength: number;
  detectedAt: string;
};

export type SimulationChartBar = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  status: "forming" | "final" | "unknown";
  indicatorValues: Record<string, number>;
};

export type SimulationChartIndicator = {
  id: string;
  kind: string;
  status: string;
  values: Record<string, number>;
};

export type SimulationChartView = {
  symbol: string;
  name?: string;
  currency: "KRW" | "USD";
  bars: SimulationChartBar[];
  indicators: SimulationChartIndicator[];
  patterns: SimulationChartPattern[];
  updatedAt?: string;
};

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedTimestamp(value: unknown): string | undefined {
  const raw = text(value);
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function boundedStrength(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 10_000) / 10_000));
}

function candleParts(bar: SimulationChartBar) {
  const range = Math.max(Number.EPSILON, bar.high - bar.low);
  const body = Math.abs(bar.close - bar.open);
  return {
    range,
    body,
    upperWick: bar.high - Math.max(bar.open, bar.close),
    lowerWick: Math.min(bar.open, bar.close) - bar.low,
    bullish: bar.close > bar.open,
    bearish: bar.close < bar.open,
  };
}

type RegressionLine = {
  slope: number;
  intercept: number;
  rmse: number;
};

type IndexedPrice = {
  index: number;
  price: number;
};

type StructuralBoundaries = {
  upper: RegressionLine;
  lower: RegressionLine;
  startWidth: number;
  endWidth: number;
  fitQuality: number;
  containment: number;
};

const STRUCTURAL_WINDOWS = [9, 12, 16, 20, 24, 30, 36, 42] as const;
const CHANNEL_WINDOWS = [12, 20, 30] as const;
const PIVOT_LOOKBACK = 72;
const ONE_MINUTE_MS = 60_000;

function average(values: readonly number[]): number {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
}

function averageTrueRange(bars: readonly SimulationChartBar[]): number {
  if (!bars.length) return 0;
  return average(bars.map((bar, index) => {
    const previousClose = bars[index - 1]?.close ?? bar.open;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  }));
}

function regression(points: readonly IndexedPrice[]): RegressionLine {
  if (!points.length) return { slope: 0, intercept: 0, rmse: Number.POSITIVE_INFINITY };
  const meanIndex = average(points.map((point) => point.index));
  const meanPrice = average(points.map((point) => point.price));
  const denominator = points.reduce(
    (total, point) => total + (point.index - meanIndex) ** 2,
    0,
  );
  const slope = denominator <= Number.EPSILON
    ? 0
    : points.reduce(
      (total, point) => total + (point.index - meanIndex) * (point.price - meanPrice),
      0,
    ) / denominator;
  const intercept = meanPrice - slope * meanIndex;
  const rmse = Math.sqrt(average(points.map(
    (point) => (point.price - (intercept + slope * point.index)) ** 2,
  )));
  return { slope, intercept, rmse };
}

function lineValue(line: RegressionLine, index: number): number {
  return line.intercept + line.slope * index;
}

function segmentedExtrema(
  bars: readonly SimulationChartBar[],
  field: "high" | "low",
): IndexedPrice[] {
  const segmentCount = Math.min(4, Math.max(3, Math.floor(bars.length / 3)));
  const points: IndexedPrice[] = [];
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const start = Math.floor(segment * bars.length / segmentCount);
    const end = Math.max(start + 1, Math.floor((segment + 1) * bars.length / segmentCount));
    let selectedIndex = start;
    for (let index = start + 1; index < end; index += 1) {
      const selected = bars[selectedIndex]!;
      const candidate = bars[index]!;
      if ((field === "high" && candidate.high > selected.high)
        || (field === "low" && candidate.low < selected.low)) {
        selectedIndex = index;
      }
    }
    points.push({ index: selectedIndex, price: bars[selectedIndex]![field] });
  }
  return points;
}

function structuralBoundaries(
  bars: readonly SimulationChartBar[],
  atr: number,
): StructuralBoundaries | undefined {
  if (bars.length < 6) return undefined;
  const upper = regression(segmentedExtrema(bars, "high"));
  const lower = regression(segmentedExtrema(bars, "low"));
  const startWidth = lineValue(upper, 0) - lineValue(lower, 0);
  const endWidth = lineValue(upper, bars.length - 1) - lineValue(lower, bars.length - 1);
  if (!(startWidth > 0) || !(endWidth > 0)) return undefined;
  const scale = Math.max(startWidth, endWidth, atr, Number.EPSILON);
  const fitQuality = boundedStrength(1 - (upper.rmse + lower.rmse) / (scale * 0.7));
  const allowance = Math.max(atr * 0.35, scale * 0.08);
  const contained = bars.filter((bar, index) => (
    bar.high <= lineValue(upper, index) + allowance
    && bar.low >= lineValue(lower, index) - allowance
  )).length / bars.length;
  return {
    upper,
    lower,
    startWidth,
    endWidth,
    fitQuality,
    containment: contained,
  };
}

function contiguousFinalBarSegments(
  bars: readonly SimulationChartBar[],
): SimulationChartBar[][] {
  const segments: SimulationChartBar[][] = [];
  let segment: SimulationChartBar[] = [];
  for (const bar of bars) {
    if (bar.status !== "final") continue;
    const previous = segment.at(-1);
    if (previous
      && Date.parse(bar.timestamp) - Date.parse(previous.timestamp) !== ONE_MINUTE_MS) {
      segments.push(segment);
      segment = [];
    }
    segment.push(bar);
  }
  if (segment.length) segments.push(segment);
  return segments;
}

function boundaryTouchEvidence(
  bars: readonly SimulationChartBar[],
  boundaries: StructuralBoundaries,
  atr: number,
): {
  upperTouches: number;
  lowerTouches: number;
  distributed: boolean;
} {
  const scale = Math.max(boundaries.startWidth, boundaries.endWidth, atr, Number.EPSILON);
  const tolerance = Math.max(atr * 0.25, scale * 0.06);
  const splitAt = Math.ceil(bars.length / 2);
  const upper = bars.flatMap((bar, index) => (
    Math.abs(bar.high - lineValue(boundaries.upper, index)) <= tolerance ? [index] : []
  ));
  const lower = bars.flatMap((bar, index) => (
    Math.abs(bar.low - lineValue(boundaries.lower, index)) <= tolerance ? [index] : []
  ));
  const spansBothHalves = (touches: readonly number[]) => (
    touches.some((index) => index < splitAt)
    && touches.some((index) => index >= splitAt)
  );
  return {
    upperTouches: upper.length,
    lowerTouches: lower.length,
    distributed: spansBothHalves(upper) && spansBothHalves(lower),
  };
}

function volumeConfirmation(
  formation: readonly SimulationChartBar[],
  breakout: SimulationChartBar,
): number {
  const historical = formation
    .map((bar) => bar.volume)
    .filter((volume): volume is number => volume !== undefined && volume > 0);
  if (breakout.volume === undefined || breakout.volume <= 0 || historical.length < 3) return 0.5;
  return boundedStrength(breakout.volume / Math.max(average(historical) * 1.5, Number.EPSILON));
}

function structuralStrength(
  geometry: number,
  breakoutDistance: number,
  atr: number,
  formation: readonly SimulationChartBar[],
  breakout: SimulationChartBar,
): number {
  const breakoutQuality = boundedStrength(breakoutDistance / Math.max(atr, Number.EPSILON));
  return boundedStrength(
    geometry * 0.6
    + breakoutQuality * 0.25
    + volumeConfirmation(formation, breakout) * 0.15,
  );
}

function appendPattern(
  patterns: Map<string, SimulationChartPattern>,
  pattern: SimulationChartPattern,
): void {
  const key = `${pattern.detectedAt}\u0000${pattern.name}`;
  const existing = patterns.get(key);
  if (!existing || pattern.strength > existing.strength) patterns.set(key, pattern);
}

function detectBoundaryStructuresAt(
  finalized: readonly SimulationChartBar[],
  currentIndex: number,
  patterns: Map<string, SimulationChartPattern>,
): void {
  const current = finalized[currentIndex]!;
  const previous = finalized[currentIndex - 1];
  if (!previous) return;

  for (const window of STRUCTURAL_WINDOWS) {
    if (currentIndex < window) continue;
    const formation = finalized.slice(currentIndex - window, currentIndex);
    const atr = averageTrueRange(formation.slice(-14));
    if (!(atr > 0)) continue;
    const boundaries = structuralBoundaries(formation, atr);
    if (!boundaries || boundaries.fitQuality < 0.42 || boundaries.containment < 0.68) continue;

    const lastIndex = formation.length - 1;
    const nextIndex = formation.length;
    const upperMove = lineValue(boundaries.upper, lastIndex) - lineValue(boundaries.upper, 0);
    const lowerMove = lineValue(boundaries.lower, lastIndex) - lineValue(boundaries.lower, 0);
    const flatThreshold = Math.max(atr * 0.55, boundaries.startWidth * 0.13);
    const directionalThreshold = Math.max(atr * 0.35, boundaries.startWidth * 0.08);
    const contraction = 1 - boundaries.endWidth / boundaries.startWidth;
    const tolerance = Math.max(atr * 0.08, current.close * 0.00015);
    const upperNow = lineValue(boundaries.upper, nextIndex);
    const upperPrevious = lineValue(boundaries.upper, lastIndex);
    const lowerNow = lineValue(boundaries.lower, nextIndex);
    const lowerPrevious = lineValue(boundaries.lower, lastIndex);
    const breaksAbove = current.close > upperNow + tolerance
      && previous.close <= upperPrevious + tolerance;
    const breaksBelow = current.close < lowerNow - tolerance
      && previous.close >= lowerPrevious - tolerance;
    if (!breaksAbove && !breaksBelow) continue;

    const geometry = boundedStrength(
      boundaries.fitQuality * 0.55
      + boundaries.containment * 0.25
      + boundedStrength(contraction / 0.5) * 0.2,
    );

    const upperFlat = Math.abs(upperMove) <= flatThreshold;
    const lowerFlat = Math.abs(lowerMove) <= flatThreshold;
    const upperFalling = upperMove < -directionalThreshold;
    const upperRising = upperMove > directionalThreshold;
    const lowerFalling = lowerMove < -directionalThreshold;
    const lowerRising = lowerMove > directionalThreshold;

    if (contraction >= 0.18) {
      if (upperFalling && lowerRising) {
        const distance = breaksAbove ? current.close - upperNow : lowerNow - current.close;
        appendPattern(patterns, {
          name: "symmetric_triangle",
          bias: breaksAbove ? "bullish" : "bearish",
          strength: structuralStrength(geometry, distance, atr, formation, current),
          detectedAt: current.timestamp,
        });
      } else if (upperFlat && lowerRising && breaksAbove) {
        appendPattern(patterns, {
          name: "ascending_triangle",
          bias: "bullish",
          strength: structuralStrength(geometry, current.close - upperNow, atr, formation, current),
          detectedAt: current.timestamp,
        });
      } else if (lowerFlat && upperFalling && breaksBelow) {
        appendPattern(patterns, {
          name: "descending_triangle",
          bias: "bearish",
          strength: structuralStrength(geometry, lowerNow - current.close, atr, formation, current),
          detectedAt: current.timestamp,
        });
      } else if (upperRising && lowerRising && lowerMove > upperMove + directionalThreshold * 0.35
        && breaksBelow) {
        appendPattern(patterns, {
          name: "rising_wedge",
          bias: "bearish",
          strength: structuralStrength(geometry, lowerNow - current.close, atr, formation, current),
          detectedAt: current.timestamp,
        });
      } else if (upperFalling && lowerFalling && upperMove < lowerMove - directionalThreshold * 0.35
        && breaksAbove) {
        appendPattern(patterns, {
          name: "falling_wedge",
          bias: "bullish",
          strength: structuralStrength(geometry, current.close - upperNow, atr, formation, current),
          detectedAt: current.timestamp,
        });
      }
    }
  }
}

function detectChannelBreakoutAt(
  finalized: readonly SimulationChartBar[],
  currentIndex: number,
  patterns: Map<string, SimulationChartPattern>,
): void {
  const current = finalized[currentIndex]!;
  for (const window of CHANNEL_WINDOWS) {
    if (currentIndex < window) continue;
    const formation = finalized.slice(currentIndex - window, currentIndex);
    const atr = averageTrueRange(formation.slice(-14));
    if (!(atr > 0)) continue;
    const boundaries = structuralBoundaries(formation, atr);
    if (!boundaries || boundaries.fitQuality < 0.5 || boundaries.containment < 0.75) continue;
    const touchEvidence = boundaryTouchEvidence(formation, boundaries, atr);
    if (touchEvidence.upperTouches < 2
      || touchEvidence.lowerTouches < 2
      || !touchEvidence.distributed) continue;

    const lastIndex = formation.length - 1;
    const nextIndex = formation.length;
    const upperMove = lineValue(boundaries.upper, lastIndex) - lineValue(boundaries.upper, 0);
    const lowerMove = lineValue(boundaries.lower, lastIndex) - lineValue(boundaries.lower, 0);
    const parallelTolerance = Math.max(atr * 0.6, boundaries.startWidth * 0.2);
    const widthRatio = boundaries.endWidth / boundaries.startWidth;
    if (Math.abs(upperMove - lowerMove) > parallelTolerance
      || widthRatio < 0.75
      || widthRatio > 1.25) continue;

    const tolerance = Math.max(atr * 0.05, current.close * 0.0001);
    const upperNow = lineValue(boundaries.upper, nextIndex);
    const upperPrevious = lineValue(boundaries.upper, lastIndex);
    const lowerNow = lineValue(boundaries.lower, nextIndex);
    const lowerPrevious = lineValue(boundaries.lower, lastIndex);
    const channelQuality = boundedStrength(
      boundaries.fitQuality * 0.45
      + boundaries.containment * 0.3
      + boundedStrength(1 - Math.abs(1 - widthRatio)) * 0.15
      + boundedStrength(
        Math.min(touchEvidence.upperTouches, touchEvidence.lowerTouches) / 4,
      ) * 0.1,
    );
    if (current.close > upperNow + tolerance
      && finalized[currentIndex - 1]!.close <= upperPrevious + tolerance) {
      appendPattern(patterns, {
        name: "bullish_channel_breakout",
        bias: "bullish",
        strength: structuralStrength(
          channelQuality,
          current.close - upperNow,
          atr,
          formation,
          current,
        ),
        detectedAt: current.timestamp,
      });
    } else if (current.close < lowerNow - tolerance
      && finalized[currentIndex - 1]!.close >= lowerPrevious - tolerance) {
      appendPattern(patterns, {
        name: "bearish_channel_breakout",
        bias: "bearish",
        strength: structuralStrength(
          channelQuality,
          lowerNow - current.close,
          atr,
          formation,
          current,
        ),
        detectedAt: current.timestamp,
      });
    }
  }
}

function consolidationBoundaryMoves(bars: readonly SimulationChartBar[]): {
  upperMove: number;
  lowerMove: number;
  contraction: number;
} | undefined {
  const atr = averageTrueRange(bars);
  const boundaries = structuralBoundaries(bars, atr);
  if (!boundaries) return undefined;
  const lastIndex = bars.length - 1;
  return {
    upperMove: lineValue(boundaries.upper, lastIndex) - lineValue(boundaries.upper, 0),
    lowerMove: lineValue(boundaries.lower, lastIndex) - lineValue(boundaries.lower, 0),
    contraction: 1 - boundaries.endWidth / boundaries.startWidth,
  };
}

function detectContinuationAt(
  finalized: readonly SimulationChartBar[],
  currentIndex: number,
  patterns: Map<string, SimulationChartPattern>,
): void {
  const current = finalized[currentIndex]!;
  for (const consolidationLength of [6, 8, 10, 12] as const) {
    for (const poleLength of [3, 4, 5, 6] as const) {
      if (currentIndex < consolidationLength + poleLength) continue;
      const consolidation = finalized.slice(
        currentIndex - consolidationLength,
        currentIndex,
      );
      const pole = finalized.slice(
        currentIndex - consolidationLength - poleLength,
        currentIndex - consolidationLength,
      );
      const combined = [...pole, ...consolidation];
      const atr = averageTrueRange(combined);
      if (!(atr > 0)) continue;
      const poleMove = pole.at(-1)!.close - pole[0]!.open;
      const poleMagnitude = Math.abs(poleMove);
      const price = Math.max(Math.abs(pole[0]!.open), Number.EPSILON);
      if (poleMagnitude < atr * 2.4 || poleMagnitude / price < 0.004) continue;

      const high = Math.max(...consolidation.map((bar) => bar.high));
      const low = Math.min(...consolidation.map((bar) => bar.low));
      const tolerance = Math.max(atr * 0.06, current.close * 0.0001);
      const bullish = poleMove > 0;
      const breakout = bullish ? current.close - high : low - current.close;
      if (breakout <= tolerance) continue;

      const poleEnd = pole.at(-1)!.close;
      const retained = bullish
        ? low >= poleEnd - poleMagnitude * 0.68
        : high <= poleEnd + poleMagnitude * 0.68;
      if (!retained || high - low > poleMagnitude * 0.82) continue;

      const moves = consolidationBoundaryMoves(consolidation);
      if (!moves) continue;
      const parallelTolerance = Math.max(atr * 0.8, poleMagnitude * 0.16);
      const isPennant = moves.contraction >= 0.22
        && moves.upperMove < parallelTolerance * 0.35
        && moves.lowerMove > -parallelTolerance * 0.35;
      const isFlag = !isPennant
        && Math.abs(moves.upperMove - moves.lowerMove) <= parallelTolerance
        && (bullish
          ? moves.upperMove <= parallelTolerance * 0.5
          : moves.lowerMove >= -parallelTolerance * 0.5);
      if (!isPennant && !isFlag) continue;

      const retracement = bullish
        ? Math.max(0, poleEnd - low) / poleMagnitude
        : Math.max(0, high - poleEnd) / poleMagnitude;
      const geometry = boundedStrength(
        0.55
        + boundedStrength(1 - retracement / 0.68) * 0.25
        + (isPennant ? boundedStrength(moves.contraction / 0.6) : 0.5) * 0.2,
      );
      appendPattern(patterns, {
        name: isPennant
          ? bullish ? "bullish_pennant" : "bearish_pennant"
          : bullish ? "bullish_flag" : "bearish_flag",
        bias: bullish ? "bullish" : "bearish",
        strength: structuralStrength(geometry, breakout, atr, consolidation, current),
        detectedAt: current.timestamp,
      });
    }
  }
}

function confirmedPivots(
  bars: readonly SimulationChartBar[],
  field: "high" | "low",
): IndexedPrice[] {
  const pivots: IndexedPrice[] = [];
  for (let index = 1; index < bars.length - 1; index += 1) {
    const value = bars[index]![field];
    const previous = bars[index - 1]![field];
    const next = bars[index + 1]![field];
    if ((field === "high" && value > previous && value >= next)
      || (field === "low" && value < previous && value <= next)) {
      pivots.push({ index, price: value });
    }
  }
  return pivots;
}

function crossedBelow(
  current: SimulationChartBar,
  previous: SimulationChartBar,
  currentLevel: number,
  previousLevel: number,
  tolerance: number,
): boolean {
  return current.close < currentLevel - tolerance && previous.close >= previousLevel - tolerance;
}

function crossedAbove(
  current: SimulationChartBar,
  previous: SimulationChartBar,
  currentLevel: number,
  previousLevel: number,
  tolerance: number,
): boolean {
  return current.close > currentLevel + tolerance && previous.close <= previousLevel + tolerance;
}

function detectReversalStructuresAt(
  finalized: readonly SimulationChartBar[],
  currentIndex: number,
  patterns: Map<string, SimulationChartPattern>,
): void {
  if (currentIndex < 7) return;
  const start = Math.max(0, currentIndex - PIVOT_LOOKBACK);
  const formation = finalized.slice(start, currentIndex);
  const current = finalized[currentIndex]!;
  const previous = finalized[currentIndex - 1]!;
  const atr = averageTrueRange(formation.slice(-14));
  if (!(atr > 0)) return;
  const tolerance = Math.max(atr * 0.22, current.close * 0.001);
  const highs = confirmedPivots(formation, "high");
  const lows = confirmedPivots(formation, "low");

  for (let rightIndex = 1; rightIndex < highs.length; rightIndex += 1) {
    const left = highs[rightIndex - 1]!;
    const right = highs[rightIndex]!;
    const valley = lows
      .filter((pivot) => pivot.index > left.index && pivot.index < right.index)
      .sort((a, b) => a.price - b.price)[0];
    if (!valley || right.index - left.index < 3 || formation.length - right.index > 24) continue;
    const topDifference = Math.abs(left.price - right.price);
    const height = Math.min(left.price, right.price) - valley.price;
    if (topDifference > Math.max(atr * 1.2, height * 0.3) || height < atr * 1.25) continue;
    if (!crossedBelow(current, previous, valley.price, valley.price, tolerance)) continue;
    const geometry = boundedStrength(
      (1 - topDifference / Math.max(height, atr)) * 0.6
      + boundedStrength(height / (atr * 4)) * 0.4,
    );
    appendPattern(patterns, {
      name: "double_top",
      bias: "bearish",
      strength: structuralStrength(geometry, valley.price - current.close, atr, formation, current),
      detectedAt: current.timestamp,
    });
  }

  for (let rightIndex = 1; rightIndex < lows.length; rightIndex += 1) {
    const left = lows[rightIndex - 1]!;
    const right = lows[rightIndex]!;
    const peak = highs
      .filter((pivot) => pivot.index > left.index && pivot.index < right.index)
      .sort((a, b) => b.price - a.price)[0];
    if (!peak || right.index - left.index < 3 || formation.length - right.index > 24) continue;
    const bottomDifference = Math.abs(left.price - right.price);
    const height = peak.price - Math.max(left.price, right.price);
    if (bottomDifference > Math.max(atr * 1.2, height * 0.3) || height < atr * 1.25) continue;
    if (!crossedAbove(current, previous, peak.price, peak.price, tolerance)) continue;
    const geometry = boundedStrength(
      (1 - bottomDifference / Math.max(height, atr)) * 0.6
      + boundedStrength(height / (atr * 4)) * 0.4,
    );
    appendPattern(patterns, {
      name: "double_bottom",
      bias: "bullish",
      strength: structuralStrength(geometry, current.close - peak.price, atr, formation, current),
      detectedAt: current.timestamp,
    });
  }

  for (let rightIndex = 2; rightIndex < highs.length; rightIndex += 1) {
    const left = highs[rightIndex - 2]!;
    const head = highs[rightIndex - 1]!;
    const right = highs[rightIndex]!;
    const leftValley = lows
      .filter((pivot) => pivot.index > left.index && pivot.index < head.index)
      .sort((a, b) => a.price - b.price)[0];
    const rightValley = lows
      .filter((pivot) => pivot.index > head.index && pivot.index < right.index)
      .sort((a, b) => a.price - b.price)[0];
    if (!leftValley || !rightValley || formation.length - right.index > 24) continue;
    const shoulderDifference = Math.abs(left.price - right.price);
    const necklineHeight = average([leftValley.price, rightValley.price]);
    const patternHeight = head.price - necklineHeight;
    if (head.price - Math.max(left.price, right.price) < Math.max(atr * 0.45, patternHeight * 0.12)
      || shoulderDifference > Math.max(atr * 1.25, patternHeight * 0.32)
      || patternHeight < atr * 1.6) continue;
    const neckline = regression([leftValley, rightValley]);
    const currentLevel = lineValue(neckline, formation.length);
    const previousLevel = lineValue(neckline, formation.length - 1);
    if (!crossedBelow(current, previous, currentLevel, previousLevel, tolerance)) continue;
    const geometry = boundedStrength(
      (1 - shoulderDifference / Math.max(patternHeight, atr)) * 0.55
      + boundedStrength((head.price - Math.max(left.price, right.price)) / atr) * 0.45,
    );
    appendPattern(patterns, {
      name: "head_and_shoulders",
      bias: "bearish",
      strength: structuralStrength(
        geometry,
        currentLevel - current.close,
        atr,
        formation,
        current,
      ),
      detectedAt: current.timestamp,
    });
  }

  for (let rightIndex = 2; rightIndex < lows.length; rightIndex += 1) {
    const left = lows[rightIndex - 2]!;
    const head = lows[rightIndex - 1]!;
    const right = lows[rightIndex]!;
    const leftPeak = highs
      .filter((pivot) => pivot.index > left.index && pivot.index < head.index)
      .sort((a, b) => b.price - a.price)[0];
    const rightPeak = highs
      .filter((pivot) => pivot.index > head.index && pivot.index < right.index)
      .sort((a, b) => b.price - a.price)[0];
    if (!leftPeak || !rightPeak || formation.length - right.index > 24) continue;
    const shoulderDifference = Math.abs(left.price - right.price);
    const necklineHeight = average([leftPeak.price, rightPeak.price]);
    const patternHeight = necklineHeight - head.price;
    if (Math.min(left.price, right.price) - head.price < Math.max(atr * 0.45, patternHeight * 0.12)
      || shoulderDifference > Math.max(atr * 1.25, patternHeight * 0.32)
      || patternHeight < atr * 1.6) continue;
    const neckline = regression([leftPeak, rightPeak]);
    const currentLevel = lineValue(neckline, formation.length);
    const previousLevel = lineValue(neckline, formation.length - 1);
    if (!crossedAbove(current, previous, currentLevel, previousLevel, tolerance)) continue;
    const geometry = boundedStrength(
      (1 - shoulderDifference / Math.max(patternHeight, atr)) * 0.55
      + boundedStrength((Math.min(left.price, right.price) - head.price) / atr) * 0.45,
    );
    appendPattern(patterns, {
      name: "inverse_head_and_shoulders",
      bias: "bullish",
      strength: structuralStrength(
        geometry,
        current.close - currentLevel,
        atr,
        formation,
        current,
      ),
      detectedAt: current.timestamp,
    });
  }
}

export function detectSimulationChartPatterns(
  bars: readonly SimulationChartBar[],
): SimulationChartPattern[] {
  const patterns = new Map<string, SimulationChartPattern>();
  for (let index = 0; index < bars.length; index += 1) {
    const current = bars[index]!;
    if (current.status !== "final") continue;
    const currentParts = candleParts(current);
    const minimumBody = Math.max(currentParts.range * 0.04, Number.EPSILON);
    const effectiveBody = Math.max(currentParts.body, minimumBody);

    if (currentParts.lowerWick >= effectiveBody * 2
      && currentParts.upperWick <= effectiveBody
      && Math.max(current.open, current.close) >= current.low + currentParts.range * 0.6) {
      appendPattern(patterns, {
        name: "hammer",
        bias: "bullish",
        strength: boundedStrength(currentParts.lowerWick / currentParts.range),
        detectedAt: current.timestamp,
      });
    }
    if (currentParts.upperWick >= effectiveBody * 2
      && currentParts.lowerWick <= effectiveBody
      && Math.min(current.open, current.close) <= current.low + currentParts.range * 0.4) {
      appendPattern(patterns, {
        name: "shooting_star",
        bias: "bearish",
        strength: boundedStrength(currentParts.upperWick / currentParts.range),
        detectedAt: current.timestamp,
      });
    }

    const previous = bars[index - 1];
    if (!previous || previous.status !== "final") continue;
    const previousParts = candleParts(previous);
    const previousBodyHigh = Math.max(previous.open, previous.close);
    const previousBodyLow = Math.min(previous.open, previous.close);
    const currentBodyHigh = Math.max(current.open, current.close);
    const currentBodyLow = Math.min(current.open, current.close);
    if (previousParts.bearish && currentParts.bullish
      && currentBodyLow <= previousBodyLow
      && currentBodyHigh >= previousBodyHigh) {
      appendPattern(patterns, {
        name: "bullish_engulfing",
        bias: "bullish",
        strength: boundedStrength(currentParts.body / Math.max(previousParts.body, minimumBody)),
        detectedAt: current.timestamp,
      });
    }
    if (previousParts.bullish && currentParts.bearish
      && currentBodyLow <= previousBodyLow
      && currentBodyHigh >= previousBodyHigh) {
      appendPattern(patterns, {
        name: "bearish_engulfing",
        bias: "bearish",
        strength: boundedStrength(currentParts.body / Math.max(previousParts.body, minimumBody)),
        detectedAt: current.timestamp,
      });
    }
    if (current.high < previous.high && current.low > previous.low) {
      appendPattern(patterns, {
        name: "inside_bar",
        bias: "neutral",
        strength: boundedStrength(1 - currentParts.range / Math.max(previousParts.range, Number.EPSILON)),
        detectedAt: current.timestamp,
      });
    } else if (current.high > previous.high && current.low < previous.low) {
      appendPattern(patterns, {
        name: currentParts.bullish ? "bullish_outside_bar" : "bearish_outside_bar",
        bias: currentParts.bullish ? "bullish" : "bearish",
        strength: boundedStrength(currentParts.range / Math.max(previousParts.range, currentParts.range) - 0.05),
        detectedAt: current.timestamp,
      });
    }
  }

  // Structural patterns are evaluated only from the finalized prefix preceding each
  // candidate breakout. A forming candle can therefore neither confirm a pattern nor
  // move a historical detection timestamp when it is updated.
  for (const finalized of contiguousFinalBarSegments(bars)) {
    for (let index = 0; index < finalized.length; index += 1) {
      detectBoundaryStructuresAt(finalized, index, patterns);
      detectContinuationAt(finalized, index, patterns);
      detectReversalStructuresAt(finalized, index, patterns);
      detectChannelBreakoutAt(finalized, index, patterns);
    }
  }
  return [...patterns.values()]
    .sort((left, right) => (
      left.detectedAt.localeCompare(right.detectedAt)
      || left.name.localeCompare(right.name)
    ))
    .slice(-MAX_CHART_PATTERNS);
}

function normalizeBar(value: unknown): SimulationChartBar | undefined {
  const source = record(value);
  const timestamp = normalizedTimestamp(
    source.timestamp ?? source.closeTime ?? source.close_time ?? source.openTime ?? source.open_time,
  );
  const open = finite(source.open);
  const high = finite(source.high);
  const low = finite(source.low);
  const close = finite(source.close);
  if (!timestamp || open === undefined || high === undefined || low === undefined || close === undefined
    || open <= 0 || high <= 0 || low <= 0 || close <= 0
    || high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    return undefined;
  }
  const rawStatus = source.status ?? source.state;
  const status = rawStatus === "forming" || rawStatus === "final" || rawStatus === "unknown"
    ? rawStatus
    : source.complete === true ? "final" : "unknown";
  const volume = finite(source.volume);
  return {
    timestamp,
    open,
    high,
    low,
    close,
    ...(volume !== undefined && volume >= 0 ? { volume } : {}),
    status,
    indicatorValues: {},
  };
}

function pointList(value: unknown): UnknownRecord[] {
  const source = record(value);
  const points = list(source.points).map(record);
  if (points.length) return points;
  const latest = record(source.latest);
  return Object.keys(latest).length ? [latest] : [];
}

function pointValues(value: UnknownRecord): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record(value.values)).flatMap(([key, raw]) => {
      const number = finite(raw);
      return number === undefined ? [] : [[key, number]];
    }),
  );
}

function applySeries(
  barsByTimestamp: Map<string, SimulationChartBar>,
  series: unknown,
  prefix: string,
): void {
  for (const point of pointList(series)) {
    const timestamp = normalizedTimestamp(point.timestamp);
    const bar = timestamp ? barsByTimestamp.get(timestamp) : undefined;
    if (!bar) continue;
    for (const [field, value] of Object.entries(pointValues(point))) {
      bar.indicatorValues[`${prefix}:${field}`] = value;
    }
  }
}

function mergeTechnical(
  chart: SimulationChartView,
  technicalInput: unknown,
): void {
  const technical = record(technicalInput);
  const barsByTimestamp = new Map(chart.bars.map((bar) => [bar.timestamp, bar]));
  const intraday = record(technical.intraday);
  applySeries(barsByTimestamp, intraday.session_vwap, "session-vwap");
  applySeries(barsByTimestamp, intraday.anchored_vwap, "anchored-vwap");

  const indicators: SimulationChartIndicator[] = [];
  for (const item of list(technical.indicators)) {
    const indicator = record(item);
    const id = text(indicator.id ?? indicator.indicatorId ?? indicator.indicator_id);
    const kind = text(indicator.kind);
    if (!id || !kind) continue;
    applySeries(barsByTimestamp, indicator, id);
    const points = pointList(indicator);
    const availability = record(indicator.availability);
    indicators.push({
      id,
      kind,
      status: text(availability.status) ?? "unavailable",
      values: points.length ? pointValues(points.at(-1)!) : {},
    });
  }
  chart.indicators = indicators;
  chart.patterns = detectSimulationChartPatterns(chart.bars);
}

export function simulationChartsFromWorkspace(
  value: ScalpingWorkspaceResult,
  symbols: readonly string[],
): SimulationChartView[] {
  const wanted = new Set(symbols);
  const metadataBySymbol = new Map(
    value.workspace.candidates.map((candidate) => [candidate.symbol, candidate]),
  );
  const charts = value.workspace.instruments.flatMap((instrument) => {
    if (!wanted.has(instrument.symbol)) return [];
    const metadata = metadataBySymbol.get(instrument.symbol);
    const bars = instrument.bars
      .flatMap((bar) => normalizeBar(bar) ?? [])
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .slice(-MAX_CHART_BARS);
    const chart: SimulationChartView = {
      symbol: instrument.symbol,
      ...(metadata?.name ? { name: metadata.name } : {}),
      currency: metadata?.currency === "USD" ? "USD" : "KRW",
      bars,
      indicators: [],
      patterns: [],
      updatedAt: value.workspace.generatedAt,
    };
    mergeTechnical(chart, instrument.technical);
    return [chart];
  });
  const chartBySymbol = new Map(charts.map((chart) => [chart.symbol, chart]));
  for (const symbol of symbols) {
    if (chartBySymbol.has(symbol)) continue;
    const metadata = metadataBySymbol.get(symbol);
    chartBySymbol.set(symbol, {
      symbol,
      ...(metadata?.name ? { name: metadata.name } : {}),
      currency: metadata?.currency === "USD" ? "USD" : "KRW",
      bars: [],
      indicators: [],
      patterns: [],
      updatedAt: value.workspace.generatedAt,
    });
  }
  return symbols.flatMap((symbol) => chartBySymbol.get(symbol) ?? []);
}

export function mergeSimulationFinalBar(
  chart: SimulationChartView,
  payload: unknown,
  observedAt?: string,
): boolean {
  const bar = normalizeBar(payload);
  const source = record(payload);
  if (!bar || bar.status !== "final" || source.intervalMinutes !== 1) return false;
  return upsertSimulationChartBar(chart, bar, observedAt, true);
}

export function mergeSimulationFormingBar(
  chart: SimulationChartView,
  payload: unknown,
  observedAt?: string,
): boolean {
  const bar = normalizeBar(payload);
  const source = record(payload);
  if (!bar || bar.status !== "forming" || source.intervalMinutes !== 1) return false;
  return upsertSimulationChartBar(chart, bar, observedAt, false);
}

function upsertSimulationChartBar(
  chart: SimulationChartView,
  bar: SimulationChartBar,
  observedAt: string | undefined,
  refreshPatterns: boolean,
): boolean {
  const existingIndex = chart.bars.findIndex((candidate) => candidate.timestamp === bar.timestamp);
  if (existingIndex >= 0) {
    const existing = chart.bars[existingIndex]!;
    // A late forming update must never downgrade an already finalized candle.
    if (existing.status === "final" && bar.status === "forming") return false;
    const unchanged = existing.open === bar.open
      && existing.high === bar.high
      && existing.low === bar.low
      && existing.close === bar.close
      && existing.volume === bar.volume
      && existing.status === bar.status;
    if (unchanged) return false;
    chart.bars[existingIndex] = { ...bar, indicatorValues: existing.indicatorValues };
  } else {
    chart.bars.push(bar);
    chart.bars.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    if (chart.bars.length > MAX_CHART_BARS) {
      chart.bars.splice(0, chart.bars.length - MAX_CHART_BARS);
    }
  }
  chart.updatedAt = normalizedTimestamp(observedAt) ?? bar.timestamp;
  if (refreshPatterns) chart.patterns = detectSimulationChartPatterns(chart.bars);
  return true;
}

export function mergeSimulationLatestTechnical(
  chart: SimulationChartView,
  result: ScalpingRealtimeAnalysisResult,
): void {
  if (!("instruments" in result.technical)) return;
  const instrument = result.technical.instruments.find(
    (candidate: ScalpingAnalysisInstrument) => candidate.instrument_key === chart.symbol,
  );
  if (!instrument) return;
  mergeTechnical(chart, instrument);
  chart.updatedAt = result.generatedAt;
}

export function latestSimulationPatternObservation(
  chart: SimulationChartView | undefined,
): {
  chartPatternBias: SimulationChartPatternBias;
  chartPatterns: string[];
  chartPatternStrength: number;
  patternObservedAt?: string;
} {
  const latestAt = chart?.bars.filter((bar) => bar.status === "final").at(-1)?.timestamp;
  if (!chart || !latestAt) {
    return { chartPatternBias: "neutral", chartPatterns: [], chartPatternStrength: 0 };
  }
  const latest = chart.patterns.filter((pattern) => pattern.detectedAt === latestAt);
  if (!latest.length) {
    return { chartPatternBias: "neutral", chartPatterns: [], chartPatternStrength: 0 };
  }
  const directional = latest.filter((pattern) => pattern.bias !== "neutral");
  const bullish = directional.filter((pattern) => pattern.bias === "bullish")
    .reduce((maximum, pattern) => Math.max(maximum, pattern.strength), 0);
  const bearish = directional.filter((pattern) => pattern.bias === "bearish")
    .reduce((maximum, pattern) => Math.max(maximum, pattern.strength), 0);
  return {
    chartPatternBias: bullish === bearish ? "neutral" : bullish > bearish ? "bullish" : "bearish",
    chartPatterns: latest.map((pattern) => pattern.name),
    chartPatternStrength: Math.max(bullish, bearish),
    patternObservedAt: latestAt,
  };
}
