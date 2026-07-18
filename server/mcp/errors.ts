import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ServiceError } from "../services/service-envelope.js";

export function toolError(error: unknown): CallToolResult {
  const detail = error instanceof ServiceError
    ? error.detail
    : {
        code: "TOOL_EXECUTION_FAILED",
        message: "도구 실행 중 내부 오류가 발생했습니다.",
        retryable: true,
      };
  return {
    isError: true,
    structuredContent: { error: detail },
    content: [{ type: "text", text: `${detail.code}: ${detail.message}` }],
  };
}
