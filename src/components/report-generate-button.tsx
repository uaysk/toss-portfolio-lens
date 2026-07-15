import { useState } from "react";
import { ExternalLink, FileChartColumn, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApiError, ReportCreateResponse } from "@/types";

export function ReportGenerateButton({
  endpoint,
  requestBody,
  onUnauthorized,
}: {
  endpoint: string;
  requestBody: unknown;
  onUnauthorized: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [report, setReport] = useState<ReportCreateResponse>();
  const [error, setError] = useState("");

  const createReport = async () => {
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
        onUnauthorized();
        return;
      }
      if (!response.ok || !payload.url) {
        throw new Error(payload.error?.message || "AI 평가 보고서를 생성하지 못했습니다.");
      }
      setReport(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI 평가 보고서를 생성하지 못했습니다.");
    } finally {
      setCreating(false);
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
