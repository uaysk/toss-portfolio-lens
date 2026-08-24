import { useEffect, useRef, useState } from "react";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import FileChartColumn from "lucide-react/dist/esm/icons/file-chart-column.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import { Button } from "@/components/ui/button";
import { currentAuthenticationSessionEpoch } from "@/lib/auth-session";
import type { ApiError, ReportCreateResponse } from "@/types";

const DEFAULT_MAXIMUM_RECEIPTS = 8;
const MAXIMUM_REQUEST_KEY_CHARACTERS = 64 * 1024;

export class ReportReceiptCache {
  private readonly receipts = new Map<string, ReportCreateResponse>();

  constructor(private readonly maximumReceipts = DEFAULT_MAXIMUM_RECEIPTS) {
    if (!Number.isInteger(maximumReceipts) || maximumReceipts < 1) {
      throw new Error("보고서 영수증 보관 상한은 1 이상의 정수여야 합니다.");
    }
  }

  key(endpoint: string, requestBody: unknown): string | undefined {
    try {
      const body = JSON.stringify(requestBody);
      if (body === undefined) return undefined;
      const key = `${currentAuthenticationSessionEpoch()}\n${endpoint}\n${body}`;
      return key.length <= MAXIMUM_REQUEST_KEY_CHARACTERS ? key : undefined;
    } catch {
      return undefined;
    }
  }

  remember(key: string | undefined, receipt: ReportCreateResponse): void {
    if (!key) return;
    this.receipts.delete(key);
    this.receipts.set(key, { ...receipt });
    while (this.receipts.size > this.maximumReceipts) {
      const oldest = this.receipts.keys().next().value;
      if (oldest === undefined) break;
      this.receipts.delete(oldest);
    }
  }

  recover(key: string | undefined): ReportCreateResponse | undefined {
    if (!key) return undefined;
    const receipt = this.receipts.get(key);
    return receipt ? { ...receipt } : undefined;
  }
}

// A completed POST can outlive its React view. Keep only a small, tab-memory
// receipt set so returning to the same inputs restores the generated link
// without persisting account or strategy inputs in browser storage.
const reportReceiptCache = new ReportReceiptCache();

export function ReportGenerateButton({
  endpoint,
  requestBody,
  onUnauthorized,
}: {
  endpoint: string;
  requestBody: unknown;
  onUnauthorized: () => void;
}) {
  const receiptKey = reportReceiptCache.key(endpoint, requestBody);
  const [creating, setCreating] = useState(false);
  const [report, setReport] = useState<ReportCreateResponse | undefined>(() => (
    reportReceiptCache.recover(receiptKey)
  ));
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const requestRevision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestRevision.current += 1;
    };
  }, []);

  useEffect(() => {
    requestRevision.current += 1;
    setCreating(false);
    setError("");
    setReport(reportReceiptCache.recover(receiptKey));
  }, [receiptKey]);

  const createReport = async () => {
    // Report creation is a durable server mutation. Client cancellation cannot
    // atomically roll it back once storage has started, so let the request
    // settle and suppress only stale React updates after this view unmounts.
    const revision = ++requestRevision.current;
    setCreating(true);
    setError("");
    setReport(undefined);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json().catch(() => ({})) as ReportCreateResponse & ApiError;
      if (response.status === 401) {
        if (!mounted.current || requestRevision.current !== revision) return;
        onUnauthorized();
        return;
      }
      if (!response.ok || !payload.url) {
        if (!mounted.current || requestRevision.current !== revision) return;
        throw new Error(payload.error?.message || "AI 평가 보고서를 생성하지 못했습니다.");
      }
      reportReceiptCache.remember(receiptKey, payload);
      if (!mounted.current || requestRevision.current !== revision) return;
      setReport(payload);
    } catch (caught) {
      if (mounted.current && requestRevision.current === revision) {
        setError(caught instanceof Error ? caught.message : "AI 평가 보고서를 생성하지 못했습니다.");
      }
    } finally {
      if (mounted.current && requestRevision.current === revision) setCreating(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void createReport()} disabled={creating}>
          {creating ? <LoaderCircle className="animate-spin" /> : <FileChartColumn />}
          {creating ? "수치를 평가하고 보고서 작성 중" : "AI 평가 보고서 생성"}
        </Button>
        {report ? (
          <Button asChild type="button" variant="secondary">
            <a href={report.url} target="_blank" rel="noreferrer">
              보고서 열기 <ExternalLink />
            </a>
          </Button>
        ) : null}
      </div>
      {creating ? <p className="text-[11px] text-muted-foreground">수치 계산과 AI 평가에 최대 1분 정도 걸릴 수 있습니다.</p> : null}
      {report ? (
        <p className="max-w-md break-all text-[11px] text-muted-foreground" aria-live="polite">
          {report.storage === "s3" ? "S3" : "로컬"} 저장 완료 · {report.url}
        </p>
      ) : null}
      {error ? <p role="alert" className="max-w-md text-[11px] font-bold text-rose-500">{error}</p> : null}
    </div>
  );
}
