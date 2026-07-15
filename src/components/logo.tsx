import { cn } from "@/lib/utils";

export function Logo({ inverse = false, className }: { inverse?: boolean; className?: string }) {
  return (
    <div className={cn("inline-flex items-center gap-3", className)} aria-label="Portfolio Lens">
      <span
        className={cn(
          "grid size-9 place-items-center rounded-[13px] text-[11px] font-black tracking-[-0.08em]",
          inverse ? "bg-white text-black" : "bg-primary text-primary-foreground",
        )}
        aria-hidden="true"
      >
        PL
      </span>
      <span className={cn("text-[15px] font-extrabold tracking-[-0.025em]", inverse ? "text-white" : "text-foreground")}>
        Portfolio Lens
      </span>
    </div>
  );
}
