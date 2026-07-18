import { z } from "zod";
import type { BacktestTargetWeightScheduleEntry } from "@/types";

const historyDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "유효한 YYYY-MM-DD 날짜가 필요합니다.");
const symbol = z.string().trim().regex(/^[A-Za-z0-9.-]{1,32}$/);
const scheduleEntry = z.object({
  date: historyDate,
  weights: z.record(symbol, z.number().finite().min(0).max(100)),
  cashTargetPercent: z.number().finite().min(0).max(100).optional().default(0),
  regime: z.string().trim().min(1).max(80).optional(),
  action: z.string().trim().min(1).max(80).optional(),
}).strict();
const schedule = z.array(scheduleEntry).max(10_000);

export type TargetWeightScheduleParseResult = {
  value?: BacktestTargetWeightScheduleEntry[];
  error?: string;
};

export function parseTargetWeightScheduleJson(input: string, options: {
  assetSymbols: string[];
  startDate: string;
  endDate: string;
}): TargetWeightScheduleParseResult {
  let json: unknown = [];
  try {
    json = input.trim() ? JSON.parse(input) : [];
  } catch {
    return { error: "목표비중 일정이 올바른 JSON이 아닙니다." };
  }

  const parsed = schedule.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue.path.length ? `${issue.path.join(".")} · ` : "";
    return { error: `${location}${issue.message}` };
  }

  const expectedSymbols = new Set(options.assetSymbols.map((item) => item.trim().toUpperCase()));
  const dates = new Set<string>();
  const normalized: BacktestTargetWeightScheduleEntry[] = [];
  for (const [index, entry] of parsed.data.entries()) {
    if (entry.date < options.startDate || entry.date > options.endDate) {
      return { error: `${index + 1}번째 일정 날짜는 백테스트 기간 안이어야 합니다.` };
    }
    if (dates.has(entry.date)) return { error: `${entry.date} 일정이 중복되었습니다.` };
    dates.add(entry.date);

    const originalSymbols = Object.keys(entry.weights);
    const normalizedSymbols = originalSymbols.map((item) => item.toUpperCase());
    if (new Set(normalizedSymbols).size !== originalSymbols.length) {
      return { error: `${index + 1}번째 일정에 대소문자만 다른 중복 종목이 있습니다.` };
    }
    const weights = Object.fromEntries(Object.entries(entry.weights).map(([key, value]) => [key.toUpperCase(), value]));
    const scheduleSymbols = Object.keys(weights);
    if (scheduleSymbols.length !== expectedSymbols.size || scheduleSymbols.some((item) => !expectedSymbols.has(item))) {
      return { error: `${index + 1}번째 일정은 현재 구성 종목을 빠짐없이 정확히 포함해야 합니다.` };
    }
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0) + entry.cashTargetPercent;
    if (Math.abs(total - 100) > 0.01) {
      return { error: `${index + 1}번째 일정의 종목과 현금 비중 합계는 100%여야 합니다.` };
    }
    normalized.push({ ...entry, weights });
  }
  return { value: normalized };
}
