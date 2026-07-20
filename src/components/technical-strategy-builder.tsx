import { memo, useMemo } from "react";
import { AlertCircle, Braces, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  MAX_TECHNICAL_CONDITION_DEPTH,
  defaultTechnicalCondition,
  technicalConditionDepth,
  technicalIndicatorReferenceOptions,
  technicalSignalStatusLabel,
  validateTechnicalStrategyDraft,
  type TechnicalBarField,
  type TechnicalCondition,
  type TechnicalConditionOperand,
  type TechnicalStrategy,
  type TechnicalStrategyAnalysis,
  type TechnicalStrategySignal,
  type TechnicalStrategyState,
} from "@/lib/technical-strategy";
import { cn } from "@/lib/utils";

const comparisonLabels = {
  greater_than: "보다 큼",
  less_than: "보다 작음",
  crosses_above: "상향 돌파",
  crosses_below: "하향 돌파",
} as const;

const operatorLabels: Record<TechnicalCondition["operator"], string> = {
  ...comparisonLabels,
  between: "범위 안",
  all: "모두 충족",
  any: "하나 이상 충족",
  not: "조건 반전",
};

function number(value: string, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstDynamicOperand(analysis: TechnicalStrategyAnalysis): TechnicalConditionOperand {
  return defaultTechnicalCondition(analysis).left;
}

function comparisonFrom(condition: TechnicalCondition, analysis: TechnicalStrategyAnalysis, operator: keyof typeof comparisonLabels): TechnicalCondition {
  if ("left" in condition) return { operator, left: condition.left, right: condition.right };
  if (condition.operator === "between") return { operator, left: condition.value, right: condition.lower };
  return { operator, left: firstDynamicOperand(analysis), right: { type: "constant", value: 0 } };
}

function changeOperator(condition: TechnicalCondition, operator: TechnicalCondition["operator"], analysis: TechnicalStrategyAnalysis): TechnicalCondition {
  if (operator in comparisonLabels) return comparisonFrom(condition, analysis, operator as keyof typeof comparisonLabels);
  if (operator === "between") {
    const value = "left" in condition ? condition.left : condition.operator === "between" ? condition.value : firstDynamicOperand(analysis);
    return { operator, value, lower: { type: "constant", value: 0 }, upper: { type: "constant", value: 100 } };
  }
  if (operator === "all" || operator === "any") {
    const child = condition.operator === "all" || condition.operator === "any" ? condition.conditions[0] : condition.operator === "not" ? condition.condition : condition;
    return { operator, conditions: [child ?? defaultTechnicalCondition(analysis)] };
  }
  return { operator: "not", condition: condition.operator === "not" ? condition.condition : condition };
}

function OperandEditor({ analysis, value, onChange, label }: {
  analysis: TechnicalStrategyAnalysis;
  value: TechnicalConditionOperand;
  onChange: (value: TechnicalConditionOperand) => void;
  label: string;
}) {
  const references = useMemo(() => technicalIndicatorReferenceOptions(analysis), [analysis]);
  const referenceKey = value.type === "indicator" ? `${value.instrumentKey}\u0000${value.indicatorId}\u0000${value.field}` : "";
  return (
    <fieldset className="min-w-0 rounded-[16px] bg-secondary p-3">
      <legend className="px-1 text-[9px] font-black text-muted-foreground">{label}</legend>
      <Select
        value={value.type}
        onValueChange={(type) => {
          if (type === "constant") onChange({ type, value: 0 });
          else if (type === "bar") onChange({ type, instrumentKey: analysis.symbols[0], field: "close" });
          else {
            const first = references[0];
            onChange(first
              ? { type: "indicator", instrumentKey: first.instrumentKey, indicatorId: first.indicatorId, field: first.field }
              : { type: "bar", instrumentKey: analysis.symbols[0], field: "close" });
          }
        }}
      >
        <SelectTrigger className="h-9 w-full bg-card" aria-label={`${label} 유형`}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="indicator">지표 출력</SelectItem>
          <SelectItem value="bar">OHLCV</SelectItem>
          <SelectItem value="constant">상수</SelectItem>
        </SelectContent>
      </Select>
      {value.type === "constant" ? (
        <Input aria-label={`${label} 상수`} type="number" value={value.value} onChange={(event) => onChange({ ...value, value: number(event.target.value) })} className="mt-2 h-9 bg-card text-right" />
      ) : value.type === "bar" ? (
        <div className="mt-2 grid min-w-0 grid-cols-2 gap-2">
          <Select value={value.instrumentKey} onValueChange={(instrumentKey) => onChange({ ...value, instrumentKey })}>
            <SelectTrigger className="h-9 min-w-0 bg-card" aria-label={`${label} bar 종목`}><SelectValue /></SelectTrigger>
            <SelectContent>{analysis.symbols.map((symbol) => <SelectItem key={symbol} value={symbol}>{symbol}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={value.field} onValueChange={(field) => onChange({ ...value, field: field as TechnicalBarField })}>
            <SelectTrigger className="h-9 min-w-0 bg-card" aria-label={`${label} bar 필드`}><SelectValue /></SelectTrigger>
            <SelectContent>{(["open", "high", "low", "close", "volume"] as const).map((field) => <SelectItem key={field} value={field}>{field}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      ) : (
        <Select
          value={referenceKey}
          onValueChange={(key) => {
            const reference = references.find((item) => `${item.instrumentKey}\u0000${item.indicatorId}\u0000${item.field}` === key);
            if (reference) onChange({ type: "indicator", instrumentKey: reference.instrumentKey, indicatorId: reference.indicatorId, field: reference.field });
          }}
        >
          <SelectTrigger className="mt-2 h-9 w-full min-w-0 bg-card" aria-label={`${label} 지표 출력`}><SelectValue placeholder="지표 출력 선택" /></SelectTrigger>
          <SelectContent>{references.map((reference) => {
            const key = `${reference.instrumentKey}\u0000${reference.indicatorId}\u0000${reference.field}`;
            return <SelectItem key={key} value={key}>{reference.label}</SelectItem>;
          })}</SelectContent>
        </Select>
      )}
    </fieldset>
  );
}

function ConditionEditor({ analysis, value, onChange, onRemove, depth, label }: {
  analysis: TechnicalStrategyAnalysis;
  value: TechnicalCondition;
  onChange: (value: TechnicalCondition) => void;
  onRemove?: () => void;
  depth: number;
  label: string;
}) {
  const canNest = depth < MAX_TECHNICAL_CONDITION_DEPTH;
  return (
    <fieldset className={cn("min-w-0 rounded-[20px] border border-border bg-card p-3 sm:p-4", depth > 1 && "bg-secondary/45")} data-technical-condition={value.operator}>
      <legend className="px-1 text-[10px] font-black">{label}</legend>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={value.operator} onValueChange={(operator) => onChange(changeOperator(value, operator as TechnicalCondition["operator"], analysis))}>
          <SelectTrigger className="w-full min-w-0 bg-secondary sm:w-48" aria-label={`${label} 연산자`}><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(operatorLabels).map(([operator, text]) => <SelectItem key={operator} value={operator}>{text}</SelectItem>)}</SelectContent>
        </Select>
        <span className="text-[9px] text-muted-foreground">depth {depth}</span>
        {onRemove ? <Button type="button" variant="ghost" size="icon" className="sm:ml-auto" onClick={onRemove} aria-label={`${label} 삭제`}><Trash2 /></Button> : null}
      </div>

      {"left" in value ? (
        <div className="mt-3 grid min-w-0 gap-2 lg:grid-cols-2">
          <OperandEditor analysis={analysis} value={value.left} label="왼쪽 값" onChange={(left) => onChange({ ...value, left })} />
          <OperandEditor analysis={analysis} value={value.right} label="오른쪽 값" onChange={(right) => onChange({ ...value, right })} />
        </div>
      ) : value.operator === "between" ? (
        <div className="mt-3 grid min-w-0 gap-2 lg:grid-cols-3">
          <OperandEditor analysis={analysis} value={value.value} label="검사 값" onChange={(target) => onChange({ ...value, value: target })} />
          <OperandEditor analysis={analysis} value={value.lower} label="하한" onChange={(lower) => onChange({ ...value, lower })} />
          <OperandEditor analysis={analysis} value={value.upper} label="상한" onChange={(upper) => onChange({ ...value, upper })} />
        </div>
      ) : value.operator === "not" ? (
        <div className="mt-3 min-w-0">
          <ConditionEditor analysis={analysis} value={value.condition} onChange={(condition) => onChange({ ...value, condition })} depth={depth + 1} label={`${label} · NOT`} />
        </div>
      ) : (
        <div className="mt-3 min-w-0 space-y-2">
          {value.conditions.map((condition, index) => (
            <ConditionEditor
              key={`${index}:${condition.operator}`}
              analysis={analysis}
              value={condition}
              depth={depth + 1}
              label={`${label} · ${index + 1}`}
              onChange={(next) => onChange({ ...value, conditions: value.conditions.map((item, itemIndex) => itemIndex === index ? next : item) })}
              onRemove={value.conditions.length > 1 ? () => onChange({ ...value, conditions: value.conditions.filter((_, itemIndex) => itemIndex !== index) }) : undefined}
            />
          ))}
          {canNest ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => onChange({ ...value, conditions: [...value.conditions, defaultTechnicalCondition(analysis)] })}><Plus />비교 조건</Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => onChange({ ...value, conditions: [...value.conditions, { operator: "all", conditions: [defaultTechnicalCondition(analysis)] }] })}><Braces />조건 그룹</Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => onChange({ ...value, conditions: [...value.conditions, { operator: "not", condition: defaultTechnicalCondition(analysis) }] })}>NOT</Button>
            </div>
          ) : <p className="text-[9px] font-bold text-muted-foreground">최대 조건 깊이에 도달했습니다.</p>}
        </div>
      )}
    </fieldset>
  );
}

function AllocationEditor({ state, symbols, value, onChange }: {
  state: TechnicalStrategyState;
  symbols: string[];
  value: TechnicalStrategy["allocations"][TechnicalStrategyState];
  onChange: (value: TechnicalStrategy["allocations"][TechnicalStrategyState]) => void;
}) {
  const total = Object.values(value.weights).reduce((sum, weight) => sum + weight, 0) + value.cashPercent;
  const even = () => {
    const weight = symbols.length ? 100 / symbols.length : 0;
    onChange({ weights: Object.fromEntries(symbols.map((symbol) => [symbol, weight])), cashPercent: 0 });
  };
  return (
    <div className="min-w-0 rounded-[20px] bg-card p-4" data-technical-allocation={state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><p className="text-xs font-black">{state === "active" ? "ACTIVE 배분" : "INACTIVE 배분"}</p><p className="mt-1 text-[9px] text-muted-foreground">종목과 현금 합계가 정확히 100%여야 합니다.</p></div>
        <span className={cn("rounded-full bg-secondary px-2.5 py-1 text-[10px] font-black", Math.abs(total - 100) > 0.01 && "text-destructive")}>{total.toFixed(2)}%</span>
      </div>
      <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {symbols.map((symbol) => (
          <label key={symbol} className="min-w-0 rounded-[14px] bg-secondary p-3">
            <span className="mb-1 block truncate text-[9px] font-black">{symbol}</span>
            <Input type="number" min={0} max={100} step={0.01} value={value.weights[symbol] ?? 0} aria-label={`${state} ${symbol} 비중`} onChange={(event) => onChange({ ...value, weights: { ...value.weights, [symbol]: number(event.target.value) } })} className="h-9 bg-card text-right" />
          </label>
        ))}
        <label className="min-w-0 rounded-[14px] bg-secondary p-3">
          <span className="mb-1 block text-[9px] font-black">현금</span>
          <Input type="number" min={0} max={100} step={0.01} value={value.cashPercent} aria-label={`${state} 현금 비중`} onChange={(event) => onChange({ ...value, cashPercent: number(event.target.value) })} className="h-9 bg-card text-right" />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={even}>균등 배분</Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => onChange({ weights: Object.fromEntries(symbols.map((symbol) => [symbol, 0])), cashPercent: 100 })}>현금 100%</Button>
      </div>
    </div>
  );
}

export const TechnicalStrategyBuilder = memo(function TechnicalStrategyBuilder({ analysis, value, onChange, title = "기술 신호 조건과 상태 배분", disabled = false }: {
  analysis: TechnicalStrategyAnalysis;
  value: TechnicalStrategy;
  onChange: (value: TechnicalStrategy) => void;
  title?: string;
  disabled?: boolean;
}) {
  const errors = useMemo(() => validateTechnicalStrategyDraft(analysis, value), [analysis, value]);
  return (
    <div className={cn("min-w-0 space-y-3", disabled && "pointer-events-none opacity-60")} data-technical-strategy-builder data-technical-strategy-valid={errors.length ? "false" : "true"}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">TYPED CONDITION TREE</p><h3 className="mt-1 text-lg font-black">{title}</h3><p className="mt-2 max-w-3xl text-[10px] leading-5 text-muted-foreground">브라우저는 조건 구조만 편집합니다. 지표 계산, 신호 판정, 안전 거래일 지정과 목표비중 일정 생성은 공통 Rust job에서 수행합니다.</p></div>
        <span className={cn("w-fit rounded-full px-3 py-1.5 text-[10px] font-black", errors.length ? "bg-destructive/10 text-destructive" : "bg-primary text-primary-foreground")}>{errors.length ? `${errors.length}개 확인 필요` : "구조 검증 통과"}</span>
      </div>

      <div className="grid min-w-0 gap-3 xl:grid-cols-2">
        <ConditionEditor analysis={analysis} value={value.entryCondition} onChange={(entryCondition) => onChange({ ...value, entryCondition })} depth={1} label="진입 조건 · INACTIVE → ACTIVE" />
        <ConditionEditor analysis={analysis} value={value.exitCondition} onChange={(exitCondition) => onChange({ ...value, exitCondition })} depth={1} label="청산 조건 · ACTIVE → INACTIVE" />
      </div>

      <div className="grid min-w-0 gap-3 md:grid-cols-3">
        <label className="rounded-[20px] bg-card p-4"><span className="mb-2 block text-[10px] font-black text-muted-foreground">초기 상태</span><Select value={value.initialState} onValueChange={(initialState) => onChange({ ...value, initialState: initialState as TechnicalStrategyState })}><SelectTrigger className="w-full bg-secondary" aria-label="기술 전략 초기 상태"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">ACTIVE</SelectItem><SelectItem value="inactive">INACTIVE</SelectItem></SelectContent></Select></label>
        <label className="rounded-[20px] bg-card p-4"><span className="mb-2 block text-[10px] font-black text-muted-foreground">최소 보유 기간 · bar</span><Input aria-label="기술 전략 최소 보유 기간" type="number" min={0} max={10_000} step={1} value={value.minimumHoldingPeriod} onChange={(event) => onChange({ ...value, minimumHoldingPeriod: Math.trunc(number(event.target.value)) })} className="bg-secondary text-right" /></label>
        <label className="rounded-[20px] bg-card p-4"><span className="mb-2 block text-[10px] font-black text-muted-foreground">Cooldown · bar</span><Input aria-label="기술 전략 cooldown" type="number" min={0} max={10_000} step={1} value={value.cooldownPeriod} onChange={(event) => onChange({ ...value, cooldownPeriod: Math.trunc(number(event.target.value)) })} className="bg-secondary text-right" /></label>
      </div>

      <div className="grid min-w-0 gap-3 xl:grid-cols-2">
        <AllocationEditor state="active" symbols={analysis.symbols} value={value.allocations.active} onChange={(active) => onChange({ ...value, allocations: { ...value.allocations, active } })} />
        <AllocationEditor state="inactive" symbols={analysis.symbols} value={value.allocations.inactive} onChange={(inactive) => onChange({ ...value, allocations: { ...value.allocations, inactive } })} />
      </div>

      {errors.length ? <div role="alert" className="rounded-[18px] bg-destructive/10 p-4 text-xs leading-5 text-destructive"><div className="flex items-center gap-2 font-black"><AlertCircle className="size-4" />전략 구조를 확인해 주세요.</div><ul className="mt-2 list-disc space-y-1 pl-5">{errors.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}
    </div>
  );
});

function signalAllocation(signal: TechnicalStrategySignal): string {
  const weights = Object.entries(signal.target_weights).map(([symbol, weight]) => `${symbol} ${weight.toFixed(2)}%`).join(" · ");
  return `${weights}${weights ? " · " : ""}현금 ${signal.cash_target_percent.toFixed(2)}%`;
}

function signalDate(value: string | null): string {
  return value ?? "미적용";
}

function SignalStatus({ status }: { status: TechnicalStrategySignal["status"] }) {
  return <span className={cn(
    "rounded-full px-2.5 py-1 text-[9px] font-black",
    status === "applied" ? "bg-primary text-primary-foreground"
      : status === "no_safe_trade_date" ? "bg-destructive/10 text-destructive"
        : "bg-secondary text-foreground",
  )} data-technical-signal-status={status}>{technicalSignalStatusLabel(status)}</span>;
}

function SignalMobileCard({ signal }: { signal: TechnicalStrategySignal }) {
  return (
    <div className="rounded-[18px] bg-card p-4" data-technical-signal={signal.signal_id}>
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="break-all text-xs font-black">{signal.signal_id}</p><div className="flex flex-wrap items-center gap-1.5"><SignalStatus status={signal.status} /><span className="rounded-full bg-secondary px-2.5 py-1 text-[9px] font-black">{signal.from_state} → {signal.to_state}</span></div></div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
        <div><dt className="text-muted-foreground">계산 기준일</dt><dd className="mt-1 font-black">{signal.calculation_date}</dd></div>
        <div><dt className="text-muted-foreground">신호일</dt><dd className="mt-1 font-black">{signal.signal_date}</dd></div>
        <div><dt className="text-muted-foreground">예정 거래일</dt><dd className="mt-1 font-black">{signalDate(signal.planned_trade_date)}</dd></div>
        <div><dt className="text-muted-foreground">실제 적용일</dt><dd className="mt-1 font-black">{signalDate(signal.actual_application_date)}</dd></div>
      </dl>
      <p className="mt-3 break-words text-[9px] leading-4 text-muted-foreground">{signalAllocation(signal)}</p>
    </div>
  );
}

export function TechnicalSignalTrace({ signals, previewLimit = 200 }: { signals: TechnicalStrategySignal[]; previewLimit?: number }) {
  const preview = signals.slice(0, Math.max(1, previewLimit));
  return (
    <Card className="min-w-0 bg-secondary p-5 sm:p-7" data-technical-signal-trace>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><p className="text-xs font-black tracking-[0.14em] text-muted-foreground">TECHNICAL SIGNAL TRACE</p><h3 className="mt-2 text-xl font-black tracking-[-0.035em]">신호와 안전 거래일 추적</h3><p className="mt-2 text-xs leading-5 text-muted-foreground">종가 기준 계산일, 신호일, 다음 안전 거래일과 ledger 실제 적용일을 구분합니다. 브라우저는 날짜를 이동하거나 보정하지 않습니다.</p></div>
        <span className="w-fit rounded-full bg-card px-3 py-2 text-[10px] font-black">{signals.length.toLocaleString("ko-KR")}개 신호</span>
      </div>
      {!preview.length ? <div className="mt-4 rounded-[18px] bg-card p-5 text-xs text-muted-foreground">조회 기간에 생성된 신호가 없습니다.</div> : (
        <>
          <div className="mt-4 space-y-2 md:hidden">{preview.map((signal) => <SignalMobileCard key={signal.signal_id} signal={signal} />)}</div>
          <div className="mt-4 hidden max-w-full overflow-x-auto rounded-[18px] bg-card p-2 md:block">
            <table className="w-full min-w-[1080px] text-left text-[10px]">
              <thead className="text-muted-foreground"><tr><th className="p-3">Signal ID</th><th className="p-3">처리 상태</th><th className="p-3">계산 기준일</th><th className="p-3">신호일</th><th className="p-3">예정 거래일</th><th className="p-3">실제 적용일</th><th className="p-3">상태 전환</th><th className="p-3">목표 배분</th></tr></thead>
              <tbody>{preview.map((signal) => <tr key={signal.signal_id} className="border-t border-border" data-technical-signal={signal.signal_id}><td className="max-w-40 break-all p-3 font-black">{signal.signal_id}</td><td className="p-3"><SignalStatus status={signal.status} /></td><td className="p-3">{signal.calculation_date}</td><td className="p-3">{signal.signal_date}</td><td className="p-3">{signalDate(signal.planned_trade_date)}</td><td className="p-3 font-black">{signalDate(signal.actual_application_date)}</td><td className="p-3">{signal.from_state} → {signal.to_state}</td><td className="max-w-72 break-words p-3 text-muted-foreground">{signalAllocation(signal)}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
      {signals.length > preview.length ? <p className="mt-3 text-[10px] text-muted-foreground">화면에는 처음 {preview.length.toLocaleString("ko-KR")}개만 표시합니다. 전체 시계열은 run의 technical-signals artifact에 저장됩니다.</p> : null}
    </Card>
  );
}
