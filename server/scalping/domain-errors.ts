import { z } from "zod";

export type ScalpingErrorCode =
  | "invalid-scalping-request"
  | "scalping-authentication-required"
  | "scalping-forbidden"
  | "scalping-resource-not-found"
  | "scalping-rate-limited"
  | "scalping-provider-unavailable"
  | "scalping-unavailable";

type DomainErrorOptions = {
  cause?: unknown;
};

export abstract class ScalpingDomainError extends Error {
  abstract readonly code: ScalpingErrorCode;
  abstract readonly status: number;
  readonly retryable: boolean = false;

  protected constructor(message: string, options: DomainErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
  }
}

export class ValidationError extends ScalpingDomainError {
  readonly code = "invalid-scalping-request" as const;
  readonly status = 400;

  constructor(message = "단타 보조 요청 값을 확인해 주세요.", options?: DomainErrorOptions) {
    super(message, options);
  }
}

export class AuthenticationError extends ScalpingDomainError {
  readonly code: "scalping-authentication-required" | "scalping-forbidden";
  readonly status: 401 | 403;

  constructor(
    message = "인증이 필요합니다.",
    options: DomainErrorOptions & { forbidden?: boolean } = {},
  ) {
    super(message, options);
    this.status = options.forbidden ? 403 : 401;
    this.code = options.forbidden ? "scalping-forbidden" : "scalping-authentication-required";
  }
}

export class NotFoundError extends ScalpingDomainError {
  readonly code = "scalping-resource-not-found" as const;
  readonly status = 404;

  constructor(message = "요청한 리소스를 찾을 수 없습니다.", options?: DomainErrorOptions) {
    super(message, options);
  }
}

export class RateLimitError extends ScalpingDomainError {
  readonly code = "scalping-rate-limited" as const;
  readonly status = 429;
  override readonly retryable = true;

  constructor(
    readonly retryAfterSeconds: number,
    message = "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    options?: DomainErrorOptions,
  ) {
    super(message, options);
    if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
      throw new TypeError("retryAfterSeconds must be a positive integer.");
    }
  }
}

export class ProviderUnavailableError extends ScalpingDomainError {
  readonly code = "scalping-provider-unavailable" as const;
  readonly status: 502 | 503;
  override readonly retryable = true;

  constructor(
    message = "현재 데이터 제공자를 사용할 수 없습니다.",
    options: DomainErrorOptions & { badGateway?: boolean } = {},
  ) {
    super(message, options);
    this.status = options.badGateway ? 502 : 503;
  }
}

export type ScalpingErrorResponse = {
  status: number;
  body: {
    error: {
      code: ScalpingErrorCode;
      message: string;
      issues?: z.ZodError["issues"];
    };
  };
  headers?: Record<string, string>;
};

export function mapScalpingError(error: unknown): ScalpingErrorResponse {
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "invalid-scalping-request",
          message: "단타 보조 요청 값을 확인해 주세요.",
          issues: error.issues,
        },
      },
    };
  }

  if (error instanceof ScalpingDomainError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
        },
      },
      ...(error instanceof RateLimitError
        ? { headers: { "Retry-After": String(error.retryAfterSeconds) } }
        : {}),
    };
  }

  return {
    status: 503,
    body: {
      error: {
        code: "scalping-unavailable",
        message: "단타 보조 데이터를 처리하지 못했습니다.",
      },
    },
  };
}
