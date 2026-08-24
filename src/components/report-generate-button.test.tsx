import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { invalidateAuthenticationSessionMemory } from "@/lib/auth-session";
import type { ReportCreateResponse } from "@/types";
import { ReportGenerateButton, ReportReceiptCache } from "./report-generate-button";

const source = readFileSync(
  new URL("./report-generate-button.tsx", import.meta.url),
  "utf8",
);

function receipt(id: string): ReportCreateResponse {
  return {
    id,
    url: `https://example.test/reports/${id}`,
    createdAt: "2026-08-24T00:00:00.000Z",
    storage: "local",
  };
}

describe("ReportGenerateButton durable request lifecycle", () => {
  it("does not abort the durable report POST when the view unmounts", () => {
    expect(source).not.toContain("AbortController");
    expect(source).not.toMatch(/\bsignal\s*:/);
    expect(source).not.toMatch(/\.abort\s*\(/);
    expect(source).toContain("Client cancellation cannot");
  });

  it("invalidates late request results and guards every post-request state update", () => {
    expect(source).toContain("const mounted = useRef(true)");
    expect(source).toContain("const requestRevision = useRef(0)");
    expect(source).toContain("mounted.current = false");
    expect(source).toContain("requestRevision.current += 1");
    expect(source).toContain("if (!mounted.current || requestRevision.current !== revision) return");
    expect(source).toContain("if (mounted.current && requestRevision.current === revision)");
  });

  it("records a successful durable receipt before suppressing stale view updates", () => {
    const remember = source.indexOf("reportReceiptCache.remember(receiptKey, payload)");
    const staleGuard = source.indexOf(
      "if (!mounted.current || requestRevision.current !== revision) return",
      remember,
    );

    expect(remember).toBeGreaterThan(-1);
    expect(staleGuard).toBeGreaterThan(remember);
    expect(source).toContain("reportReceiptCache.recover(receiptKey)");
  });

  it("renders one guarded report action without starting a request during render", () => {
    const markup = renderToStaticMarkup(
      <ReportGenerateButton
        endpoint="/api/reports/durable"
        requestBody={{ runId: "run-1" }}
        onUnauthorized={() => undefined}
      />,
    );

    expect(markup).toContain("AI 평가 보고서 생성");
    expect(markup).not.toContain("수치를 평가하고 보고서 작성 중");
  });
});

describe("ReportReceiptCache", () => {
  it("recovers only a receipt for the same endpoint and serialized request", () => {
    const cache = new ReportReceiptCache();
    const first = cache.key("/api/reports/backtest", { assets: ["A"], range: "1y" });
    const different = cache.key("/api/reports/backtest", { assets: ["B"], range: "1y" });

    cache.remember(first, receipt("report-a"));

    expect(cache.recover(first)).toEqual(receipt("report-a"));
    expect(cache.recover(different)).toBeUndefined();
  });

  it("bounds retained receipts without mutating recovered values", () => {
    const cache = new ReportReceiptCache(2);
    const first = cache.key("/reports", { request: 1 });
    const second = cache.key("/reports", { request: 2 });
    const third = cache.key("/reports", { request: 3 });
    cache.remember(first, receipt("report-1"));
    cache.remember(second, receipt("report-2"));

    const recovered = cache.recover(first);
    expect(recovered).toEqual(receipt("report-1"));
    if (recovered) recovered.url = "https://example.test/changed";
    cache.remember(third, receipt("report-3"));

    expect(cache.recover(first)).toBeUndefined();
    expect(cache.recover(second)).toEqual(receipt("report-2"));
    expect(cache.recover(third)).toEqual(receipt("report-3"));
  });

  it("does not expose a receipt after the authenticated session changes", () => {
    const cache = new ReportReceiptCache();
    const previousSession = cache.key("/reports", { request: 1 });
    cache.remember(previousSession, receipt("private-report"));

    invalidateAuthenticationSessionMemory();
    const nextSession = cache.key("/reports", { request: 1 });

    expect(nextSession).not.toBe(previousSession);
    expect(cache.recover(nextSession)).toBeUndefined();
  });

  it("skips unserializable or unexpectedly large request identities", () => {
    const cache = new ReportReceiptCache();
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(cache.key("/reports", circular)).toBeUndefined();
    expect(cache.key("/reports", { value: "x".repeat(65 * 1024) })).toBeUndefined();
  });
});
