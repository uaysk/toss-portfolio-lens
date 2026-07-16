import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import {
  REPORT_EVALUATION_INSTRUCTIONS,
  REPORT_NARRATIVE_SCHEMA,
  ReportGenerationError,
  parseReportNarrative,
  type ReportNarrative,
} from "./report-ai.js";

export const DEFAULT_BEDROCK_REGION = "eu-north-1";

export type BedrockReportConfig = {
  modelId: string;
  region?: string;
  timeoutMs?: number;
};

type ConverseClient = {
  send(
    command: ConverseCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ConverseCommandOutput>;
};

const retryableBedrockErrors = new Set([
  "InternalServerException",
  "ModelErrorException",
  "ModelNotReadyException",
  "ModelStreamErrorException",
  "ModelTimeoutException",
  "ServiceUnavailableException",
  "ThrottlingException",
]);

function jsonContract(): string {
  return `${REPORT_EVALUATION_INSTRUCTIONS}\n\n반환할 JSON의 정확한 스키마는 다음과 같습니다. JSON 이외의 설명이나 Markdown 코드 펜스를 붙이지 마세요.\n${JSON.stringify(REPORT_NARRATIVE_SCHEMA)}`;
}

function fencedJson(text: string): string | undefined {
  const match = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  return match?.[1]?.trim();
}

function firstJsonObject(text: string): string | undefined {
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start < 0) {
      if (character !== "{") continue;
      start = index;
      depth = 1;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
      continue;
    }
    if (character === "\"") quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

export function parseBedrockNarrativeText(text: string): ReportNarrative {
  const trimmed = text.trim();
  const candidates = [trimmed, fencedJson(trimmed), firstJsonObject(trimmed)]
    .filter((candidate): candidate is string => Boolean(candidate));
  let parsedJson = false;
  let validationError: ReportGenerationError | undefined;

  for (const candidate of new Set(candidates)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate) as unknown;
      parsedJson = true;
    } catch {
      continue;
    }
    try {
      return parseReportNarrative(value);
    } catch (error) {
      if (error instanceof ReportGenerationError) validationError = error;
      else throw error;
    }
  }

  if (validationError) throw validationError;
  throw new ReportGenerationError(
    parsedJson ? "AI 평가 형식이 올바르지 않습니다." : "AI 평가 JSON을 해석하지 못했습니다.",
    true,
  );
}

function outputText(output: ConverseCommandOutput): string {
  if (output.stopReason === "content_filtered" || output.stopReason === "guardrail_intervened") {
    throw new ReportGenerationError("AI가 이 평가 보고서 생성을 거절했습니다.");
  }
  const content = output.output?.message?.content ?? [];
  const text = content
    .filter((block): block is typeof block & { text: string } => "text" in block && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new ReportGenerationError("AI 응답에서 평가 내용을 찾지 못했습니다.", true);
  return text;
}

function bedrockError(error: unknown): ReportGenerationError {
  if (error instanceof ReportGenerationError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return new ReportGenerationError("AI 평가 생성 시간이 초과되었습니다.", true);
  }
  if (name === "AccessDeniedException") {
    return new ReportGenerationError("AI 평가 서비스 접근 권한이 없습니다.");
  }
  if (name === "ResourceNotFoundException" || name === "ValidationException") {
    return new ReportGenerationError("AI 평가 모델 설정이 올바르지 않습니다.");
  }
  if (retryableBedrockErrors.has(name)) {
    return new ReportGenerationError("AI 평가 서비스가 일시적으로 응답하지 않습니다.", true);
  }
  return new ReportGenerationError("AI 평가 서비스에 연결하지 못했습니다.", true);
}

export class BedrockReportWriter {
  private readonly client: ConverseClient;
  private readonly region: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: BedrockReportConfig,
    client?: ConverseClient,
  ) {
    if (!config.modelId.trim()) throw new Error("Bedrock modelId가 필요합니다.");
    this.region = config.region?.trim() || DEFAULT_BEDROCK_REGION;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.client = client ?? new BedrockRuntimeClient({ region: this.region });
  }

  async evaluate(input: unknown): Promise<ReportNarrative> {
    const request: ConverseCommandInput = {
      modelId: this.config.modelId,
      system: [{ text: jsonContract() }],
      messages: [{
        role: "user",
        content: [{ text: JSON.stringify(input) }],
      }],
      inferenceConfig: {
        maxTokens: 1_800,
        temperature: 0.1,
      },
    };

    let output: ConverseCommandOutput;
    try {
      output = await this.client.send(
        new ConverseCommand(request),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error) {
      throw bedrockError(error);
    }
    return parseBedrockNarrativeText(outputText(output));
  }
}
