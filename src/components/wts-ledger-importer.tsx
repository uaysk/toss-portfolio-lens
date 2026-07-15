import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, ClipboardPaste, Database, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatMoney, formatSignedMoney } from "@/lib/format";
import { seoulDateString } from "@/lib/date-range";
import { parseWtsLedger } from "@/lib/wts-ledger";
import type { ApiError, CashLedgerSummary } from "@/types";

function displayLedgerDate(date: string, time: string): string {
  return `${date.replace(/-/g, ".")} ${time}`;
}

export function WtsLedgerImporter({
  accountId,
  onUnauthorized,
}: {
  accountId: string;
  onUnauthorized: () => void;
}) {
  const today = useMemo(() => seoulDateString(), []);
  const [rawText, setRawText] = useState("");
  const [baseYear, setBaseYear] = useState(today.slice(0, 4));
  const [leadingDate, setLeadingDate] = useState("");
  const [summary, setSummary] = useState<CashLedgerSummary>();
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const parsedWithoutLeadingDate = useMemo(
    () => parseWtsLedger(rawText, { baseYear: Number(baseYear) || Number(today.slice(0, 4)) }),
    [baseYear, rawText, today],
  );
  const parsed = useMemo(
    () => parseWtsLedger(rawText, {
      baseYear: Number(baseYear) || Number(today.slice(0, 4)),
      ...(leadingDate ? { leadingDate } : {}),
    }),
    [baseYear, leadingDate, rawText, today],
  );
  const needsLeadingDate = parsedWithoutLeadingDate.unresolvedEntries > 0;
  const canImport = parsed.entries.length > 0
    && parsed.entries.length <= 1_000
    && (!needsLeadingDate || Boolean(leadingDate))
    && !saving;
  const previewEntries = rawText ? parsed.entries : summary?.entries ?? [];

  const loadSummary = () => {
    const controller = new AbortController();
    setLoadingSummary(true);
    fetch(`/api/portfolio/cash-ledger?account=${encodeURIComponent(accountId)}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as CashLedgerSummary & ApiError;
        if (response.status === 401) {
          onUnauthorized();
          return;
        }
        if (!response.ok) throw new Error(payload.error?.message || "저장된 거래내역을 불러오지 못했습니다.");
        setSummary(payload);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "저장된 거래내역을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingSummary(false);
      });
    return controller;
  };

  useEffect(() => {
    const controller = loadSummary();
    return () => controller.abort();
  // 계좌가 바뀔 때만 서버 원장을 다시 읽습니다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const importEntries = async () => {
    if (!canImport) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/portfolio/cash-ledger/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ account: accountId, entries: parsed.entries }),
      });
      const payload = await response.json().catch(() => ({})) as {
        imported?: number;
        skipped?: number;
        total?: number;
      } & ApiError;
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(payload.error?.message || "거래내역을 저장하지 못했습니다.");
      setNotice(`${payload.imported ?? 0}건 저장 · 중복 ${payload.skipped ?? 0}건 제외`);
      setRawText("");
      setLeadingDate("");
      const controller = loadSummary();
      window.setTimeout(() => controller.abort(), 10_000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "거래내역을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="bg-secondary p-5 sm:p-7">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 text-xs font-bold tracking-[0.14em] text-muted-foreground">
            <ClipboardPaste className="size-4" aria-hidden="true" /> WTS LEDGER IMPORT
          </div>
          <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">WTS 거래내역 붙여넣기</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            토스증권 WTS 거래내역 페이지에서 복사한 내용을 붙여넣으면 날짜·유형·금액·거래 후 잔액과 종목 수량을 자동으로 추출합니다.
          </p>
        </div>
        <div className="flex min-h-10 items-center gap-2 self-start rounded-full bg-card px-4 text-xs font-bold text-muted-foreground">
          {loadingSummary ? <LoaderCircle className="size-4 animate-spin" /> : <Database className="size-4" />}
          SQLite에 {summary?.total.toLocaleString("ko-KR") ?? 0}건 저장됨
        </div>
      </div>

      <div className="mt-6 grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <div className="rounded-[24px] bg-card p-4 sm:p-5">
          <div className="grid gap-2 sm:grid-cols-2">
            <label>
              <span className="mb-1.5 block px-1 text-[10px] font-bold text-muted-foreground">목록 맨 위 기준 연도</span>
              <Input
                type="number"
                min="2000"
                max={today.slice(0, 4)}
                value={baseYear}
                onChange={(event) => setBaseYear(event.target.value)}
                className="h-10 rounded-xl bg-secondary px-3 text-xs font-bold"
                aria-label="거래내역 기준 연도"
              />
            </label>
            <label className={needsLeadingDate ? "" : "opacity-55"}>
              <span className="mb-1.5 block px-1 text-[10px] font-bold text-muted-foreground">첫 날짜 제목 이전 거래일</span>
              <Input
                type="date"
                max={today}
                value={leadingDate}
                disabled={!needsLeadingDate}
                onChange={(event) => setLeadingDate(event.target.value)}
                className="h-10 rounded-xl bg-secondary px-3 text-xs font-bold"
                aria-label="첫 거래 묶음 날짜"
              />
            </label>
          </div>
          <label className="mt-3 block">
            <span className="mb-1.5 block px-1 text-[10px] font-bold text-muted-foreground">WTS에서 복사한 내용</span>
            <textarea
              value={rawText}
              onChange={(event) => {
                setRawText(event.target.value);
                setError("");
                setNotice("");
              }}
              placeholder={"예: 7.14\n샘플전자 10주\n09:30 ㅣ 구매\n-100,000원\n900,000원"}
              className="min-h-64 w-full resize-y rounded-[18px] border-0 bg-secondary p-4 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
              spellCheck={false}
            />
          </label>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs font-bold text-muted-foreground" aria-live="polite">
              {rawText ? (
                <span>추출 {parsed.entries.length.toLocaleString("ko-KR")}건{parsed.ignoredLines ? ` · 인식하지 못한 줄 ${parsed.ignoredLines}개` : ""}</span>
              ) : <span>붙여넣은 원문은 브라우저에서만 처리됩니다.</span>}
            </div>
            <Button type="button" onClick={importEntries} disabled={!canImport} className="min-w-36">
              {saving ? <LoaderCircle className="animate-spin" /> : <Database />}
              추출 내역 저장
            </Button>
          </div>
          {needsLeadingDate && !leadingDate ? (
            <div className="mt-3 flex items-start gap-2 rounded-[16px] bg-amber-400/10 px-3 py-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              날짜 제목보다 앞선 거래 {parsedWithoutLeadingDate.unresolvedEntries}건이 있습니다. 해당 묶음의 실제 거래일을 선택해 주세요.
            </div>
          ) : null}
          {parsed.entries.length > 1_000 ? <p className="mt-3 text-xs font-bold text-destructive">한 번에 최대 1,000건까지 저장할 수 있습니다. 내용을 나누어 붙여넣어 주세요.</p> : null}
          {error ? <p className="mt-3 text-xs font-bold text-destructive">{error}</p> : null}
          {notice ? <p className="mt-3 flex items-center gap-2 text-xs font-bold text-emerald-600 dark:text-emerald-300"><Check className="size-4" />{notice}</p> : null}
        </div>

        <div className="min-w-0 rounded-[24px] bg-card p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold tracking-[0.14em] text-muted-foreground">PREVIEW</p>
              <h4 className="mt-1 text-base font-black">{rawText ? "추출 미리보기" : "최근 저장 내역"}</h4>
            </div>
            {summary?.earliestDate && summary.latestDate ? (
              <p className="text-right text-[10px] font-bold text-muted-foreground">저장 범위<br />{summary.earliestDate} — {summary.latestDate}</p>
            ) : null}
          </div>
          {previewEntries.length ? (
            <div className="mt-4 max-h-[390px] space-y-2 overflow-y-auto pr-1">
              {previewEntries.slice(0, 12).map((entry, index) => (
                <div key={`${entry.occurredAt}:${entry.title}:${index}`} className="rounded-[16px] bg-secondary p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black">{entry.title}</p>
                      <p className="mt-1 text-[10px] font-bold text-muted-foreground">{displayLedgerDate(entry.date, entry.time)} · {entry.category}</p>
                    </div>
                    <p className="shrink-0 text-sm font-black">{formatSignedMoney(entry.amount, entry.currency)}</p>
                  </div>
                  <p className="mt-2 text-[10px] text-muted-foreground">거래 후 잔액 {formatMoney(entry.balance, entry.currency)}</p>
                </div>
              ))}
              {previewEntries.length > 12 ? <p className="px-2 pt-1 text-xs font-bold text-muted-foreground">외 {(previewEntries.length - 12).toLocaleString("ko-KR")}건</p> : null}
            </div>
          ) : (
            <div className="mt-4 grid min-h-64 place-items-center rounded-[18px] bg-secondary px-6 text-center">
              <div>
                <ClipboardPaste className="mx-auto size-6 text-muted-foreground" />
                <p className="mt-3 text-sm font-black">{loadingSummary ? "저장 내역을 불러오는 중입니다." : "붙여넣으면 바로 미리봅니다."}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">저장 전 거래일과 금액을 확인하고, 저장 후에는 최근 내역을 다시 볼 수 있습니다.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        원문 전체는 서버나 SQLite에 저장하지 않고 추출된 항목만 저장합니다. 같은 거래를 다시 붙여넣으면 날짜·시각·금액·잔액을 기준으로 중복 저장하지 않습니다.
      </p>
    </Card>
  );
}
