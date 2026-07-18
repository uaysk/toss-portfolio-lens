import { Eye, EyeOff, RotateCcw, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { stockColor } from "@/lib/stock-appearance";
import { cn } from "@/lib/utils";
import type { VisibilityStock } from "@/lib/visibility-settings";
import type { Theme } from "@/types";

export function StockVisibilitySettings({
  stocks,
  hiddenStockKeys,
  theme,
  onToggle,
  onShowAll,
  onClose,
}: {
  stocks: VisibilityStock[];
  hiddenStockKeys: ReadonlySet<string>;
  theme: Theme;
  onToggle: (key: string) => void;
  onShowAll: () => void;
  onClose: () => void;
}) {
  const hiddenCount = stocks.filter((stock) => hiddenStockKeys.has(stock.key)).length;
  const storedHiddenCount = hiddenStockKeys.size;

  return (
    <section id="display-settings" className="mb-3 scroll-mt-5" aria-labelledby="display-settings-title">
      <Card className="bg-secondary p-5 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-bold tracking-[0.14em] text-muted-foreground">
              <Settings2 className="size-4" aria-hidden="true" />
              DISPLAY SETTINGS
            </div>
            <h2 id="display-settings-title" className="text-2xl font-black tracking-[-0.04em]">표시할 종목</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              현재 보유 종목과 선택한 차트 기간의 과거 보유 종목입니다. 숨긴 종목은 목록, 자산 구성, 과거 차트에서 제외되며 계좌 합계는 유지됩니다.
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="표시 설정 닫기">
            <X />
          </Button>
        </div>

        <div className="mt-6 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {stocks.map((stock) => {
            const visible = !hiddenStockKeys.has(stock.key);
            return (
              <button
                key={stock.key}
                type="button"
                onClick={() => onToggle(stock.key)}
                aria-pressed={visible}
                className={cn(
                  "flex min-w-0 items-center gap-3 rounded-[20px] px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  visible ? "bg-card" : "bg-card/45 text-muted-foreground",
                )}
              >
                <span
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: stockColor(stock.symbol, theme) }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-black">{stock.name}</span>
                  <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <span className="truncate">{stock.symbol} · {stock.market}</span>
                    <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[9px] font-black">
                      {stock.isCurrent ? "현재 보유" : "과거 보유"}
                    </span>
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-bold">
                  {visible ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
                  {visible ? "표시" : "숨김"}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-5 flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            이 설정은 현재 브라우저에만 저장됩니다.
            {hiddenCount ? ` · 현재 ${hiddenCount}개 숨김` : ""}
            {storedHiddenCount > hiddenCount ? ` · 과거 설정 포함 ${storedHiddenCount}개` : ""}
          </p>
          {storedHiddenCount ? (
            <Button variant="ghost" size="sm" onClick={onShowAll}>
              <RotateCcw /> 모두 표시
            </Button>
          ) : null}
        </div>
      </Card>
    </section>
  );
}
