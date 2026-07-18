import { stockColor } from "@/lib/stock-appearance";
import { cn } from "@/lib/utils";
import type { Theme } from "@/types";

export function StockSwatch({
  symbol,
  theme,
  className,
}: {
  symbol: string;
  theme: Theme;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-stock-symbol={symbol}
      className={cn("inline-block size-2.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: stockColor(symbol, theme) }}
    />
  );
}
