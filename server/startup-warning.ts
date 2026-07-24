import type { ReadOnlyApiTokenSource } from "./env.js";

let readOnlyTokenFallbackWarningEmitted = false;

export function warnReadOnlyApiTokenFallbackOnce(
  source: ReadOnlyApiTokenSource,
  warn: (message: string) => void = console.warn,
): void {
  if (source !== "DASHBOARD_PASSWORD" || readOnlyTokenFallbackWarningEmitted) return;
  readOnlyTokenFallbackWarningEmitted = true;
  warn(
    "[auth] READ_ONLY_API_TOKEN이 없어 DASHBOARD_PASSWORD를 읽기 전용 API 인증에 사용합니다. "
    + "이 호환 fallback은 deprecated이며 별도 READ_ONLY_API_TOKEN을 설정해야 합니다.",
  );
}
