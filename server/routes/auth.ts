import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import {
  clearSessionCookie,
  createSessionCookie,
  hasValidReadOnlyApiSecret,
  hasValidSession,
  passwordsMatch,
  setNoStore,
} from "../auth.js";
import {
  LoginAttemptLimiter,
  normalizeClientIp,
} from "../auth/login-attempt-limiter.js";

export type AuthRouteDependencies = {
  dashboardPassword: string;
  readOnlyApiToken: string;
  sessionSecret: string;
  secureSessionCookie: boolean;
  loginLimiter?: LoginAttemptLimiter;
};

export type AuthRouteRuntime = {
  router: Router;
  requireSession: RequestHandler;
  requireReadOnlyApiToken: RequestHandler;
};

const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_LOGIN_ATTEMPT_ENTRIES = 10_000;

function requestIp(request: Request): string {
  return normalizeClientIp(request.ip || request.socket.remoteAddress);
}

export function createAuthRouteRuntime(dependencies: AuthRouteDependencies): AuthRouteRuntime {
  const loginLimiter = dependencies.loginLimiter ?? new LoginAttemptLimiter({
    maximumAttempts: MAX_LOGIN_ATTEMPTS,
    windowMs: LOGIN_WINDOW_MS,
    maximumEntries: MAX_LOGIN_ATTEMPT_ENTRIES,
  });
  const router = Router();

  const requireSession = (request: Request, response: Response, next: NextFunction): void => {
    if (!hasValidSession(request, dependencies.sessionSecret)) {
      setNoStore(response);
      response.status(401).json({
        error: { code: "authentication-required", message: "로그인이 필요합니다." },
      });
      return;
    }
    next();
  };

  const requireReadOnlyApiToken = (request: Request, response: Response, next: NextFunction): void => {
    if (!hasValidReadOnlyApiSecret(request.get("authorization"), dependencies.readOnlyApiToken)) {
      setNoStore(response);
      response.status(401).json({
        error: { code: "invalid-token", message: "읽기 전용 API Bearer 토큰이 필요합니다." },
      });
      return;
    }
    next();
  };

  router.get("/api/auth/session", (request, response) => {
    setNoStore(response);
    response.json({ authenticated: hasValidSession(request, dependencies.sessionSecret) });
  });

  router.post("/api/auth/login", (request, response) => {
    setNoStore(response);
    const ip = requestIp(request);
    const decision = loginLimiter.check(ip);
    if (!decision.allowed) {
      response.setHeader("Retry-After", String(decision.retryAfterSeconds));
      response.status(429).json({
        error: {
          code: "too-many-attempts",
          message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        },
      });
      return;
    }

    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!passwordsMatch(password, dependencies.dashboardPassword)) {
      loginLimiter.recordFailure(ip);
      response.status(401).json({
        error: { code: "invalid-password", message: "비밀번호가 올바르지 않습니다." },
      });
      return;
    }

    loginLimiter.reset(ip);
    response.setHeader(
      "Set-Cookie",
      createSessionCookie(request, dependencies.sessionSecret, dependencies.secureSessionCookie),
    );
    response.json({ authenticated: true });
  });

  router.post("/api/auth/logout", (request, response) => {
    setNoStore(response);
    response.setHeader("Set-Cookie", clearSessionCookie(request, dependencies.secureSessionCookie));
    response.json({ authenticated: false });
  });

  return { router, requireSession, requireReadOnlyApiToken };
}
