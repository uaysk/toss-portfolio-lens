import type { Response } from "express";
import { setNoStore } from "../auth.js";
import {
  SseConnectionBusyError,
  type SseConnectionTracker,
} from "../lifecycle.js";

type SseAdmissionTracker = Pick<SseConnectionTracker, "track">;

export function admitSseConnection(
  tracker: SseAdmissionTracker | undefined,
  response: Response,
  cleanup: () => void,
): (() => void) | undefined {
  try {
    return tracker?.track(response, cleanup) ?? (() => undefined);
  } catch (error) {
    if (!(error instanceof SseConnectionBusyError)) throw error;
    setNoStore(response);
    response.setHeader("Retry-After", "1");
    response.status(503).json({
      error: {
        code: error.code,
        message: "실시간 연결이 가득 찼습니다. 잠시 후 다시 시도해 주세요.",
        retryable: error.retryable,
      },
    });
    return undefined;
  }
}
