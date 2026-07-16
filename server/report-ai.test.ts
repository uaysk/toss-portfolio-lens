import { describe, expect, it, vi } from "vitest";
import { OpenAiReportWriter, parseReportNarrative } from "./report-ai.js";

const narrative = {
  score: 71,
  stance: "balanced",
  summary: "수익과 위험이 대체로 균형을 이루지만 집중도를 계속 점검할 필요가 있습니다.",
  strengths: ["위험 대비 수익이 안정적입니다.", "낙폭이 비교적 제한적입니다.", "복수 종목에 자산이 배분돼 있습니다."],
  risks: ["상위 종목 집중도가 높습니다.", "분석 기간이 충분히 길지 않습니다.", "입출금 원장이 반영되지 않았습니다."],
  actions: ["상위 종목 비중을 정기적으로 확인하세요.", "더 긴 기간에서도 지표를 비교하세요.", "추정치와 실제 계좌 성과를 구분하세요."],
  methodology: "제공된 수익률, 변동성, 낙폭, 집중도와 데이터 품질 정보만 함께 비교했습니다.",
} as const;

describe("OpenAI report evaluation", () => {
  it("고정된 평가 형식을 검증한다", () => {
    expect(parseReportNarrative(narrative)).toEqual(narrative);
    expect(() => parseReportNarrative({ ...narrative, score: 101 })).toThrow("형식이 올바르지 않습니다");
    expect(parseReportNarrative({
      ...narrative,
      strengths: ["PERIOD_PLACEHOLDER 양의 수익일 비율이 안정적입니다.", ...narrative.strengths.slice(1)],
    }).strengths[0]).toBe("양의 수익일 비율이 안정적입니다.");
  });

  it("Responses API와 strict JSON schema를 사용한다", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(narrative) }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const writer = new OpenAiReportWriter({
      endpoint: "https://api.openai.com/v1",
      apiKey: "secret-key",
      model: "gpt-test",
      timeoutMs: 5_000,
    }, fetcher);

    await expect(writer.evaluate({ metrics: { sharpeRatio: 1.2 } })).resolves.toEqual(narrative);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(options.body)) as Record<string, any>;
    expect(body.store).toBe(false);
    expect(body.model).toBe("gpt-test");
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "portfolio_evaluation", strict: true });
    expect(body.text.format.schema.additionalProperties).toBe(false);
  });

  it("모델 설정이 없으면 엔드포인트에서 호환 가능한 GPT-5.6 모델을 찾는다", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/models")
      ? new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }, { id: "gpt-5.6-sol" }] }), { status: 200 })
      : new Response(JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(narrative) }] }],
        }), { status: 200 })) as unknown as typeof fetch;
    const writer = new OpenAiReportWriter({
      endpoint: "https://gateway.example/v1",
      apiKey: "secret-key",
      timeoutMs: 5_000,
    }, fetcher);
    await writer.evaluate({ synthetic: true });
    const request = JSON.parse(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(request.model).toBe("gpt-5.6-sol");
  });

  it("Responses API 미지원 모델은 Chat Completions strict JSON schema로 전환한다", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/responses")
      ? new Response(JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "validation_error",
            message: "The model does not support the '/v1/responses' API",
          },
        }), { status: 400, headers: { "Content-Type": "application/json" } })
      : new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(narrative) } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const writer = new OpenAiReportWriter({
      endpoint: "https://gateway.example/v1",
      apiKey: "secret-key",
      model: "moonshotai.kimi-k2.5",
      timeoutMs: 5_000,
    }, fetcher);

    await expect(writer.evaluate({ synthetic: true })).resolves.toEqual(narrative);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toBe("https://gateway.example/v1/chat/completions");
    const request = JSON.parse(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(request.model).toBe("moonshotai.kimi-k2.5");
    expect(request.response_format.json_schema).toMatchObject({
      name: "portfolio_evaluation",
      strict: true,
    });
    expect(request.response_format.json_schema.schema.additionalProperties).toBe(false);
  });
});
