import { useEffect, useMemo, useState } from "react";
import Layers3 from "lucide-react/dist/esm/icons/layers.js";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Card } from "@/components/ui/card";
import { buildAllocation } from "@/lib/allocation";
import {
  chartTooltipItemStyle,
  chartTooltipLabelStyle,
  chartTooltipStyle,
} from "@/lib/chart-theme";
import { formatMoney, formatPercent } from "@/lib/format";
import { stockColor, stockColorMap } from "@/lib/stock-appearance";
import { cn } from "@/lib/utils";
import type { Portfolio, Theme } from "@/types";

export function PortfolioAllocationChart({
  portfolio,
  theme,
}: {
  portfolio: Portfolio;
  theme: Theme;
}) {
  const currencies = useMemo(
    () => (["KRW", "USD"] as const).filter((currency) =>
      portfolio.holdings.some((holding) => (
        holding.currency === currency && holding.evaluationAmount > 0
      )),
    ),
    [portfolio.holdings],
  );
  const [selectedCurrency, setSelectedCurrency] = useState<"KRW" | "USD">(
    portfolio.holdings.some((holding) => (
      holding.currency === "KRW" && holding.evaluationAmount > 0
    ))
      ? "KRW"
      : portfolio.holdings.some((holding) => (
        holding.currency === "USD" && holding.evaluationAmount > 0
      ))
        ? "USD"
        : "KRW",
  );

  useEffect(() => {
    if (currencies.length && !currencies.includes(selectedCurrency)) {
      setSelectedCurrency(currencies[0]);
    }
  }, [currencies, selectedCurrency]);

  const allocation = useMemo(
    () => buildAllocation(portfolio.holdings, selectedCurrency),
    [portfolio.holdings, selectedCurrency],
  );
  const allocationColors = useMemo(
    () => stockColorMap(allocation.map((item) => item.key), theme),
    [allocation, theme],
  );
  const total = allocation.reduce((sum, item) => sum + item.value, 0);

  return (
    <section id="allocation" className="scroll-mt-5">
      <Card className="grid min-h-[390px] gap-4 bg-secondary p-5 sm:p-7 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="flex flex-col">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">ALLOCATION</p>
              {currencies.length > 1 ? (
                <div className="flex rounded-full bg-card p-1">
                  {currencies.map((currency) => (
                    <button
                      key={currency}
                      type="button"
                      onClick={() => setSelectedCurrency(currency)}
                      className={cn(
                        "rounded-full px-3 py-1.5 text-[11px] font-black transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selectedCurrency === currency
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {currency}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <h2 className="text-2xl font-black tracking-[-0.04em]">
              자산 구성 · {selectedCurrency}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              보유 종목 평가액 비중입니다.
            </p>
          </div>

          <div className="mt-8 space-y-3 lg:mt-auto">
            {allocation.length ? allocation.map((item) => {
              const percent = total > 0 ? (item.value / total) * 100 : 0;
              return (
                <div key={item.key} className="flex items-center gap-3">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: allocationColors.get(item.key) ?? stockColor(item.key, theme) }}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {item.name}
                  </span>
                  <span className="text-sm font-black tabular-nums">
                    {formatPercent(percent)}
                  </span>
                </div>
              );
            }) : (
              <p className="rounded-2xl bg-card p-4 text-sm text-muted-foreground">
                표시할 보유 자산이 없습니다.
              </p>
            )}
          </div>
        </div>

        <div className="toss-chart-surface relative min-h-[290px]">
          {allocation.length ? (
            <>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={allocation}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="61%"
                    outerRadius="88%"
                    paddingAngle={2}
                    cornerRadius={7}
                    stroke="none"
                  >
                    {allocation.map((item) => (
                      <Cell
                        key={item.key}
                        fill={allocationColors.get(item.key) ?? stockColor(item.key, theme)}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    cursor={false}
                    formatter={(value) => formatMoney(Number(value), selectedCurrency)}
                    contentStyle={chartTooltipStyle}
                    labelStyle={chartTooltipLabelStyle}
                    itemStyle={chartTooltipItemStyle}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
                <div>
                  <p className="text-xs font-semibold text-muted-foreground">상위 비중</p>
                  <p className="mt-1 max-w-[120px] truncate text-lg font-black">
                    {allocation[0]?.name}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center">
              <div className="grid size-52 place-items-center rounded-full bg-card">
                <Layers3 className="size-7 text-muted-foreground/50" />
              </div>
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}
