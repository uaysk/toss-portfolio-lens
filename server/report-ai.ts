import type { OpenAiConfig } from "./env.js";

export type ReportStance = "strong" | "balanced" | "cautious" | "high-risk";

export type ReportNarrative = {
  score: number;
  stance: ReportStance;
  summary: string;
  strengths: [string, string, string];
  risks: [string, string, string];
  actions: [string, string, string];
  methodology: string;
};

const narrativeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["score", "stance", "summary", "strengths", "risks", "actions", "methodology"],
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    stance: { type: "string", enum: ["strong", "balanced", "cautious", "high-risk"] },
    summary: { type: "string", minLength: 20, maxLength: 700 },
    strengths: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "string", minLength: 5, maxLength: 220 },
    },
    risks: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "string", minLength: 5, maxLength: 220 },
    },
    actions: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "string", minLength: 5, maxLength: 220 },
    },
    methodology: { type: "string", minLength: 10, maxLength: 400 },
  },
} as const;

const instructions = `당신은 한국어 포트폴리오 분석 보고서를 작성하는 신중한 애널리스트입니다.
제공된 수치와 데이터 품질 정보만 근거로 평가하고, 제공되지 않은 시장 뉴스·기업 정보·전망은 추측하지 마세요.
실제 계좌 분석에서는 보유주식 추정 성과와 계좌 전체 성과를 명확히 구분하세요.
백테스트에서는 과거 성과가 미래 성과를 보장하지 않는다는 한계를 반영하세요.
매수·매도 지시나 수익 보장 표현은 쓰지 말고, actions는 위험 관리와 추가 확인 관점의 구체적인 점검 항목으로 작성하세요.
긍정·부정 수치를 모두 고려하고 과도하게 낙관적이거나 공포를 유발하는 표현을 피하세요.
PERIOD_PLACEHOLDER 같은 자리표시자나 템플릿 토큰을 절대 쓰지 말고, 제공된 기간과 수치를 직접 표현하세요.
모든 문장은 한국어로 작성하고 지정된 JSON 스키마만 반환하세요.`;
const placeholderPattern = /\b[A-Z][A-Z0-9_]*_PLACEHOLDER\b/gi;

export class ReportGenerationError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "ReportGenerationError";
  }
}

type FetchLike = typeof fetch;

function responsesEndpoint(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, "");
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function modelsEndpoint(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, "").replace(/\/responses$/, "");
  return `${normalized}/models`;
}

function chatCompletionsEndpoint(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, "").replace(/\/responses$/, "");
  return `${normalized}/chat/completions`;
}

function cleanText(value: string): string {
  return value.replace(placeholderPattern, "").replace(/\s{2,}/g, " ").trim();
}

function stringArray(value: unknown): [string, string, string] | undefined {
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  const cleaned = value.map((item) => cleanText(String(item)));
  return cleaned.some((item) => item.length < 5) ? undefined : cleaned as [string, string, string];
}

export function parseReportNarrative(value: unknown): ReportNarrative {
  if (!value || typeof value !== "object") throw new ReportGenerationError("AI 평가 형식이 올바르지 않습니다.");
  const input = value as Record<string, unknown>;
  const strengths = stringArray(input.strengths);
  const risks = stringArray(input.risks);
  const actions = stringArray(input.actions);
  const summary = typeof input.summary === "string" ? cleanText(input.summary) : "";
  const methodology = typeof input.methodology === "string" ? cleanText(input.methodology) : "";
  const stance = typeof input.stance === "string" && ["strong", "balanced", "cautious", "high-risk"].includes(input.stance)
    ? input.stance as ReportStance
    : undefined;
  if (!Number.isInteger(input.score) || Number(input.score) < 0 || Number(input.score) > 100
    || !stance || summary.length < 20
    || !strengths || !risks || !actions
    || methodology.length < 10) {
    throw new ReportGenerationError("AI 평가 형식이 올바르지 않습니다.");
  }
  return {
    score: Number(input.score),
    stance,
    summary: summary.slice(0, 700),
    strengths: strengths.map((item) => item.slice(0, 220)) as [string, string, string],
    risks: risks.map((item) => item.slice(0, 220)) as [string, string, string],
    actions: actions.map((item) => item.slice(0, 220)) as [string, string, string],
    methodology: methodology.slice(0, 400),
  };
}

function outputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new ReportGenerationError("AI 응답이 비어 있습니다.", true);
  const output = Array.isArray((payload as { output?: unknown }).output)
    ? (payload as { output: unknown[] }).output
    : [];
  for (const item of output) {
    if (!item || typeof item !== "object" || !Array.isArray((item as { content?: unknown }).content)) continue;
    for (const content of (item as { content: unknown[] }).content) {
      if (!content || typeof content !== "object") continue;
      if ((content as { type?: unknown }).type === "refusal") {
        throw new ReportGenerationError("AI가 이 평가 보고서 생성을 거절했습니다.");
      }
      if ((content as { type?: unknown }).type === "output_text" && typeof (content as { text?: unknown }).text === "string") {
        return (content as { text: string }).text;
      }
    }
  }
  throw new ReportGenerationError("AI 응답에서 평가 내용을 찾지 못했습니다.", true);
}

function chatOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new ReportGenerationError("AI 응답이 비어 있습니다.", true);
  const choices = Array.isArray((payload as { choices?: unknown }).choices)
    ? (payload as { choices: unknown[] }).choices
    : [];
  const message = choices[0] && typeof choices[0] === "object"
    ? (choices[0] as { message?: unknown }).message
    : undefined;
  if (!message || typeof message !== "object") {
    throw new ReportGenerationError("AI 응답에서 평가 내용을 찾지 못했습니다.", true);
  }
  if (typeof (message as { refusal?: unknown }).refusal === "string") {
    throw new ReportGenerationError("AI가 이 평가 보고서 생성을 거절했습니다.");
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string") throw new ReportGenerationError("AI 응답에서 평가 내용을 찾지 못했습니다.", true);
  return content;
}

function apiErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return "";
  return typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : "";
}

function responsesApiUnsupported(status: number, payload: unknown): boolean {
  if (status === 404 || status === 405) return true;
  const message = apiErrorMessage(payload).toLowerCase();
  return status === 400 && message.includes("does not support") && message.includes("responses");
}

export class OpenAiReportWriter {
  private resolvedModel?: Promise<string>;

  constructor(
    private readonly config: OpenAiConfig,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  private model(): Promise<string> {
    if (this.config.model) return Promise.resolve(this.config.model);
    if (!this.resolvedModel) {
      this.resolvedModel = (async () => {
        try {
          const response = await this.fetcher(modelsEndpoint(this.config.endpoint), {
            headers: { Authorization: `Bearer ${this.config.apiKey}` },
            signal: AbortSignal.timeout(Math.min(this.config.timeoutMs, 15_000)),
          });
          if (!response.ok) return "gpt-5.6";
          const payload = await response.json() as { data?: Array<{ id?: unknown }> };
          const ids = (payload.data ?? []).map((item) => typeof item.id === "string" ? item.id : "").filter(Boolean);
          const preferred = ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5"];
          return preferred.find((candidate) => ids.includes(candidate))
            ?? ids.find((candidate) => /^gpt-5\.6(?:-|$)/.test(candidate))
            ?? ids.find((candidate) => /^gpt-/.test(candidate) && !candidate.includes("codex"))
            ?? "gpt-5.6";
        } catch {
          return "gpt-5.6";
        }
      })();
    }
    return this.resolvedModel;
  }

  async evaluate(input: unknown): Promise<ReportNarrative> {
    let response: Response;
    let payload: unknown;
    let usedChatCompletions = false;
    const model = await this.model();
    try {
      response = await this.fetcher(responsesEndpoint(this.config.endpoint), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          store: false,
          instructions,
          input: [{
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(input) }],
          }],
          reasoning: { effort: "low" },
          max_output_tokens: 1_800,
          text: {
            format: {
              type: "json_schema",
              name: "portfolio_evaluation",
              strict: true,
              schema: narrativeSchema,
            },
          },
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      payload = await response.json() as unknown;
      if (!response.ok && responsesApiUnsupported(response.status, payload)) {
        usedChatCompletions = true;
        response = await this.fetcher(chatCompletionsEndpoint(this.config.endpoint), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: instructions },
              { role: "user", content: JSON.stringify(input) },
            ],
            max_tokens: 1_800,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "portfolio_evaluation",
                strict: true,
                schema: narrativeSchema,
              },
            },
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        payload = await response.json() as unknown;
      }
    } catch (error) {
      const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      if (error instanceof SyntaxError) throw new ReportGenerationError("AI 응답을 해석하지 못했습니다.", true);
      throw new ReportGenerationError(timeout ? "AI 평가 생성 시간이 초과되었습니다." : "AI 평가 서비스에 연결하지 못했습니다.", true);
    }
    if (!response.ok) {
      const requestId = response.headers.get("x-request-id");
      console.error(`[reports] OpenAI 요청 실패: ${response.status}${requestId ? ` (${requestId})` : ""}`);
      throw new ReportGenerationError(
        response.status === 429 ? "AI 보고서 요청이 많습니다. 잠시 후 다시 시도해 주세요." : "AI 평가를 생성하지 못했습니다.",
        response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(usedChatCompletions ? chatOutputText(payload) : outputText(payload)) as unknown;
    } catch (error) {
      if (error instanceof ReportGenerationError) throw error;
      throw new ReportGenerationError("AI 평가 JSON을 해석하지 못했습니다.", true);
    }
    return parseReportNarrative(parsed);
  }
}
