import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/card";
import {
  kronosForecastChartRows,
  selectExactKronosForecastActualMark,
  type AiSimulationKronosForecast,
} from "@/lib/ai-simulation-forecast";
import type { AiSimulationChartView } from "@/lib/ai-simulation";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

type AiSimulationKronosForecastSectionProps = {
  forecasts: readonly AiSimulationKronosForecast[];
  charts: readonly AiSimulationChartView[];
  currency: "KRW" | "USD";
  className?: string;
};

function chartTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function timestamp(value: string | undefined): string {
  if (!value) return "unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function probability(value: number | undefined): string {
  return value === undefined ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

function ForecastCard({
  forecast,
  charts,
  currency,
}: {
  forecast: AiSimulationKronosForecast;
  charts: readonly AiSimulationChartView[];
  currency: "KRW" | "USD";
}) {
  const actualMark = useMemo(
    () => selectExactKronosForecastActualMark(forecast, charts),
    [charts, forecast],
  );
  const rows = useMemo(
    () => kronosForecastChartRows(forecast, actualMark),
    [actualMark, forecast],
  );

  return (
    <Card
      className="min-w-0 overflow-hidden p-4 sm:p-5"
      data-ai-simulation-kronos-forecast={forecast.signalSymbol}
      data-ai-simulation-kronos-forecast-status={forecast.status}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-black">
            {forecast.signalSymbol} · Kronos-base 예측 경로
          </h3>
          <p className="mt-1 text-[9px] leading-4 text-muted-foreground">
            origin {timestamp(forecast.origin)} · 생성 {timestamp(forecast.generatedAt)}
          </p>
        </div>
        <span className={cn(
          "shrink-0 rounded-full px-2.5 py-1 text-[8px] font-black",
          forecast.status === "available"
            ? "bg-violet-500/12 text-violet-700 dark:text-violet-300"
            : "bg-amber-500/12 text-amber-700 dark:text-amber-300",
        )}>
          {forecast.status === "available" ? `${forecast.points.length}개 horizon` : "unavailable"}
        </span>
      </div>

      {forecast.status === "available" && forecast.points.length ? (
        <>
          <div
            className="mt-3 h-[280px] min-w-0 max-w-full rounded-[20px] bg-secondary p-2"
            data-ai-simulation-kronos-forecast-chart
            role="img"
            aria-label={`${forecast.signalSymbol} 실제 확정 종가와 Kronos-base Q10 중앙값 Q90 미래 가격 예측`}
          >
            <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
              <ComposedChart
                data={rows}
                margin={{ top: 18, right: 8, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  stroke="hsl(var(--border))"
                  vertical={false}
                  strokeDasharray="3 5"
                />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={chartTime}
                  minTickGap={18}
                  tick={{ fontSize: 8 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  orientation="right"
                  width={62}
                  tick={{ fontSize: 8 }}
                  tickFormatter={(value) => formatMoney(Number(value), currency, true)}
                  axisLine={false}
                  tickLine={false}
                  domain={["auto", "auto"]}
                />
                <Tooltip
                  labelFormatter={(label) => timestamp(String(label))}
                  formatter={(value, label) => [
                    Array.isArray(value)
                      ? value.map((item) => formatMoney(Number(item), currency)).join(" – ")
                      : formatMoney(Number(value), currency),
                    String(label),
                  ]}
                  cursor={{ stroke: "hsl(var(--foreground) / 0.45)", strokeWidth: 1 }}
                  wrapperStyle={{ zIndex: 30 }}
                />
                {forecast.origin ? (
                  <ReferenceLine
                    x={forecast.origin}
                    stroke="#2563eb"
                    strokeDasharray="3 3"
                    label={{
                      value: "origin",
                      fill: "#2563eb",
                      fontSize: 8,
                      position: "insideTopLeft",
                    }}
                  />
                ) : null}
                <Area
                  dataKey="predictionRange"
                  name="Kronos-base Q10–Q90 예측 범위"
                  type="linear"
                  fill="#8b5cf6"
                  fillOpacity={0.16}
                  stroke="none"
                  connectNulls={false}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="q10Price"
                  name="Kronos-base Q10 예측"
                  type="linear"
                  stroke="#7c3aed"
                  strokeDasharray="3 3"
                  strokeWidth={1}
                  dot={{ r: 2 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="medianPrice"
                  name="Kronos-base 중앙값 예측"
                  type="linear"
                  stroke="#6d28d9"
                  strokeWidth={2.25}
                  dot={{ r: 2.5 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="q90Price"
                  name="Kronos-base Q90 예측"
                  type="linear"
                  stroke="#7c3aed"
                  strokeDasharray="3 3"
                  strokeWidth={1}
                  dot={{ r: 2 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
                {actualMark ? (
                  <ReferenceDot
                    x={actualMark.timestamp}
                    y={actualMark.close}
                    r={5}
                    fill="#2563eb"
                    stroke="hsl(var(--card))"
                    strokeWidth={2}
                    ifOverflow="extendDomain"
                    isFront
                  />
                ) : null}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div
            className="mt-2 flex max-w-full flex-wrap gap-1.5 text-[8px] font-black"
            aria-label="Kronos-base 예측 그래프 범례"
          >
            <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-1 text-blue-700 dark:text-blue-300">
              <span className="size-2 rounded-full bg-blue-600" />
              실제 확정 종가
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-1 text-violet-700 dark:text-violet-300">
              <span className="h-2 w-3 rounded-sm bg-violet-500/30" />
              Kronos Q10–Q90 예측
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-1 text-violet-700 dark:text-violet-300">
              <span className="h-0.5 w-3 bg-violet-700" />
              Kronos 중앙값 예측
            </span>
          </div>

          {!actualMark ? (
            <p
              className="mt-2 rounded-xl bg-amber-500/10 px-3 py-2 text-[9px] leading-4 text-amber-800 dark:text-amber-200"
              data-ai-simulation-kronos-origin-mark="unavailable"
              role="status"
            >
              origin과 정확히 일치하는 확정봉 종가가 없어 실제 가격 점은 표시하지 않았습니다.
              이전 가격으로 대체하지 않습니다.
            </p>
          ) : (
            <p
              className="mt-2 text-[9px] font-bold text-muted-foreground"
              data-ai-simulation-kronos-origin-mark="exact-final"
            >
              실제 확정 종가 {formatMoney(actualMark.close, currency)} · {timestamp(actualMark.timestamp)}
            </p>
          )}

          <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {forecast.points.map((point) => (
              <article
                key={`${point.horizonMinutes}:${point.targetTimestamp}`}
                className="min-w-0 rounded-xl bg-secondary p-3 text-[8px]"
                data-ai-simulation-kronos-horizon={point.horizonMinutes}
              >
                <p className="font-black">+{point.horizonMinutes}분 · {chartTime(point.targetTimestamp)}</p>
                <p className="mt-1 break-words leading-4 text-muted-foreground">
                  Q10 {formatMoney(point.q10Price, currency)} · 중앙 {formatMoney(point.medianPrice, currency)} · Q90 {formatMoney(point.q90Price, currency)}
                </p>
                <p className="mt-1 text-muted-foreground">상승확률 {probability(point.upProbability)}</p>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div
          className="mt-3 grid min-h-40 place-items-center rounded-[20px] bg-secondary px-4 py-6 text-center"
          data-ai-simulation-kronos-forecast-empty
          role="status"
        >
          <div>
            <p className="text-xs font-black">Kronos-base 예측 경로 unavailable</p>
            <p className="mt-2 max-w-lg text-[9px] leading-4 text-muted-foreground">
              {forecast.unavailableReason ?? "표시 가능한 원시 가격 분위수 결과가 없습니다."}
            </p>
          </div>
        </div>
      )}

      <p className="mt-3 break-words text-[8px] leading-4 text-muted-foreground">
        모델이 반환한 target timestamp와 price_quantiles(Q10·Q50·Q90)만 표시합니다.
        누락된 horizon을 보간하거나 임의 가격을 생성하지 않습니다.
        {forecast.modelId ? ` · ${forecast.modelId}${forecast.modelRevision ? ` @ ${forecast.modelRevision}` : ""}` : ""}
      </p>
    </Card>
  );
}

export function AiSimulationKronosForecastSection({
  forecasts,
  charts,
  currency,
  className,
}: AiSimulationKronosForecastSectionProps) {
  return (
    <section
      className={cn("min-w-0 space-y-3", className)}
      data-ai-simulation-kronos-forecast-section
      aria-label="Kronos-base 미래 가격 예측"
    >
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-2 px-1">
        <div>
          <h2 className="text-sm font-black">Kronos-base 미래 가격 예측</h2>
          <p className="mt-1 text-[9px] leading-4 text-muted-foreground">
            실제 확정 가격과 모델 예측 분위수를 분리해 표시합니다.
          </p>
        </div>
        <span className="text-[8px] font-black text-muted-foreground">
          원시 모델 출력 · 보간 없음
        </span>
      </div>
      {forecasts.length ? (
        <div className="grid min-w-0 gap-3 xl:grid-cols-2">
          {forecasts.map((forecast) => (
            <ForecastCard
              key={`${forecast.signalSymbol}:${forecast.origin ?? "unavailable"}`}
              forecast={forecast}
              charts={charts}
              currency={currency}
            />
          ))}
        </div>
      ) : (
        <Card
          className="grid min-h-40 min-w-0 place-items-center bg-secondary px-4 py-6 text-center"
          data-ai-simulation-kronos-forecast-empty
          role="status"
        >
          <div>
            <p className="text-xs font-black">Kronos-base 예측 경로 unavailable</p>
            <p className="mt-2 max-w-lg text-[9px] leading-4 text-muted-foreground">
              아직 저장된 Kronos-base raw horizon 결과가 없습니다. 첫 모델 판단이 완료되면 표시됩니다.
            </p>
          </div>
        </Card>
      )}
    </section>
  );
}
