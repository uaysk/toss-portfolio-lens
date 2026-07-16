import { ConverseCommand, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { BedrockReportWriter, parseBedrockNarrativeText } from "./bedrock-report-ai.js";

const narrative = {
  score: 71,
  stance: "balanced",
  summary: "수익과 위험이 대체로 균형을 이루지만 집중도를 계속 점검할 필요가 있습니다.",
  strengths: ["위험 대비 수익이 안정적입니다.", "낙폭이 비교적 제한적입니다.", "복수 종목에 자산이 배분돼 있습니다."],
  risks: ["상위 종목 집중도가 높습니다.", "분석 기간이 충분히 길지 않습니다.", "입출금 원장이 반영되지 않았습니다."],
  actions: ["상위 종목 비중을 정기적으로 확인하세요.", "더 긴 기간에서도 지표를 비교하세요.", "추정치와 실제 계좌 성과를 구분하세요."],
  methodology: "제공된 수익률, 변동성, 낙폭, 집중도와 데이터 품질 정보만 함께 비교했습니다.",
} as const;

describe("Bedrock report evaluation", () => {
  it("Converse API로 모든 입력 지표와 JSON 계약을 전달한다", async () => {
    const client = {
      send: vi.fn(async (
        _command: ConverseCommand,
        _options?: { abortSignal?: AbortSignal },
      ): Promise<ConverseCommandOutput> => ({
        stopReason: "end_turn",
        output: { message: { role: "assistant", content: [{ text: JSON.stringify(narrative) }] } },
      })),
    };
    const writer = new BedrockReportWriter({ modelId: "moonshotai.kimi-k2.5", timeoutMs: 5_000 }, client);

    await expect(writer.evaluate({ metrics: { sharpeRatio: 1.2 }, correlations: [] })).resolves.toEqual(narrative);
    expect(client.send).toHaveBeenCalledOnce();
    const [command, options] = client.send.mock.calls[0];
    expect(command.input.modelId).toBe("moonshotai.kimi-k2.5");
    expect(command.input.system?.[0]?.text).toContain("롤링 성과");
    expect(command.input.system?.[0]?.text).toContain("성과·위험 기여도");
    expect(command.input.system?.[0]?.text).toContain('"additionalProperties":false');
    expect(JSON.parse(command.input.messages[0].content?.[0]?.text ?? "")).toEqual({
      metrics: { sharpeRatio: 1.2 },
      correlations: [],
    });
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("Markdown JSON 코드 펜스와 앞뒤 설명을 제거한 후 검증한다", () => {
    expect(parseBedrockNarrativeText(`결과입니다.\n\`\`\`json\n${JSON.stringify(narrative)}\n\`\`\`\n확인하세요.`)).toEqual(narrative);
  });

  it("문자열 내부 중괄호가 있어도 첫 JSON 객체를 정확히 추출한다", () => {
    const withBrace = { ...narrative, summary: `${narrative.summary} {보수적 해석}` };
    expect(parseBedrockNarrativeText(`평가 결과: ${JSON.stringify(withBrace)} 끝`)).toEqual(withBrace);
  });

  it("JSON이어도 보고서 계약을 위반하면 기존 검증 오류를 반환한다", () => {
    expect(() => parseBedrockNarrativeText(JSON.stringify({ ...narrative, score: 101 })))
      .toThrow("AI 평가 형식이 올바르지 않습니다.");
  });

  it("Bedrock throttling 오류는 재시도 가능한 오류로 변환한다", async () => {
    const error = Object.assign(new Error("rate limited"), { name: "ThrottlingException" });
    const client = { send: vi.fn(async () => { throw error; }) };
    const writer = new BedrockReportWriter({ modelId: "moonshotai.kimi-k2.5" }, client);

    await expect(writer.evaluate({ synthetic: true })).rejects.toMatchObject({
      name: "ReportGenerationError",
      retryable: true,
    });
  });
});
