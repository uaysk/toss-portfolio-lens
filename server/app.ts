import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import compression from "compression";
import { randomUUID } from "node:crypto";

export type CreateAppOptions = {
  trustProxy: readonly string[];
  oauthCallbackOrigin?: string;
  shutdownGate?: RequestHandler;
  requestTelemetry?: RequestHandler;
  routeRegistrars?: readonly AppRouteRegistrar[];
};

export type AppRouteRegistrar = (app: Express) => void;

type BodyRoute = {
  method: "DELETE" | "PATCH" | "POST";
  path: RegExp;
  large?: boolean;
};

const BODY_ROUTES: readonly BodyRoute[] = [
  { method: "POST", path: /^\/api\/auth\/(?:login|logout)$/ },
  { method: "POST", path: /^\/api\/portfolio\/scalping\/(?:workspace|forecast|evaluations)$/ },
  { method: "POST", path: /^\/api\/portfolio\/simulation\/runs(?:\/[^/]+\/cancel)?$/ },
  { method: "POST", path: /^\/api\/portfolio\/history\/backfill$/ },
  { method: "POST", path: /^\/api\/portfolio\/backtest$/, large: true },
  { method: "POST", path: /^\/api\/portfolio\/advanced\/(?:[^/]+|runs\/[^/]+\/cancel)$/, large: true },
  { method: "POST", path: /^\/api\/portfolio\/tools\/[^/]+$/, large: true },
  { method: "PATCH", path: /^\/api\/portfolio\/runs\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/portfolio\/runs\/[^/]+$/ },
  { method: "POST", path: /^\/api\/portfolio\/runs\/[^/]+\/(?:duplicate|rerun)$/ },
  { method: "POST", path: /^\/api\/portfolio\/presets(?:\/import|\/[^/]+\/duplicate)?$/, large: true },
  { method: "PATCH", path: /^\/api\/portfolio\/presets\/[^/]+$/, large: true },
  { method: "DELETE", path: /^\/api\/portfolio\/presets\/[^/]+$/, large: true },
  { method: "POST", path: /^\/api\/reports\/portfolio-analysis$/ },
  { method: "POST", path: /^\/api\/reports\/backtest$/, large: true },
  { method: "POST", path: /^\/mcp$/ },
  { method: "POST", path: /^\/oauth\/(?:authorize|token|revoke)$/ },
];

const responseCompression = compression({
  threshold: 1_024,
  filter: (request, response) => {
    // `send` resolves byte ranges before this middleware chooses a content
    // coding. Compressing that slice afterwards would make Content-Range refer
    // to different representation bytes than the response body.
    if (response.statusCode === 206 || response.getHeader("Content-Range") !== undefined) {
      return false;
    }
    const contentType = response.getHeader("Content-Type");
    if (
      typeof contentType === "string"
      && /^text\/event-stream(?:\s*;|$)/iu.test(contentType)
    ) {
      return false;
    }
    return compression.filter(request, response);
  },
});

function bodyRoute(request: Request): BodyRoute | undefined {
  // Express routes are case-insensitive and accept a trailing slash by
  // default. Normalize the parser lookup the same way so an alternate route
  // spelling cannot reach a handler without the configured size bound.
  const requestPath = (request.path.replace(/\/+$/u, "") || "/").toLowerCase();
  return BODY_ROUTES.find(({ method, path }) => (
    request.method === method && path.test(requestPath)
  ));
}

function bodyParserError(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!error || typeof error !== "object" || !("type" in error)) {
    next(error);
    return;
  }
  const type = String(error.type);
  if (type === "entity.too.large") {
    response.status(413).json({
      error: {
        code: "request-too-large",
        message: "요청 본문의 크기가 허용 범위를 초과했습니다.",
      },
    });
    return;
  }
  if (type === "entity.parse.failed") {
    response.status(400).json({
      error: {
        code: "invalid-request-body",
        message: "요청 본문의 형식이 올바르지 않습니다.",
      },
    });
    return;
  }
  next(error);
}

function apiErrorBoundary(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  // Express matches routes case-insensitively by default. Keep the error
  // boundary aligned so alternate casing cannot fall through to its default
  // HTML error response after an API handler throws.
  const normalizedPath = request.path.toLowerCase();
  const isApiRequest = normalizedPath === "/api" || normalizedPath.startsWith("/api/");
  if (!isApiRequest || response.headersSent) {
    next(error);
    return;
  }
  const correlationId = randomUUID();
  const diagnosticError = error instanceof Error
    ? error
    : new Error("Non-Error value reached the API error boundary", { cause: error });
  console.error(
    `[http] unhandled ${request.method} ${request.path} (${correlationId}):`,
    diagnosticError,
  );
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Request-ID", correlationId);
  response.status(500).json({
    error: {
      code: "internal-error",
      message: "요청을 처리하는 중 오류가 발생했습니다.",
      requestId: correlationId,
    },
  });
}

export function createApp(options: CreateAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxy.length) app.set("trust proxy", [...options.trustProxy]);
  if (options.requestTelemetry) app.use(options.requestTelemetry);
  app.use(responseCompression);

  app.use((request, response, next) => {
    const comparisonReport = request.path
      === "/reports/crypto-scalping-model-comparison.html";
    const formAction = request.path === "/oauth/authorize" && options.oauthCallbackOrigin
      ? `'self' ${options.oauthCallbackOrigin}`
      : "'self'";
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'${comparisonReport ? " 'unsafe-inline'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action ${formAction}`,
    );
    if (comparisonReport) {
      // The comparison report is a deliberately self-contained audited
      // artifact. Scope inline script permission and non-cacheability to this
      // exact path; every other page keeps the stricter application CSP.
      response.setHeader("Cache-Control", "no-store, max-age=0");
    }
    if (request.path.startsWith("/reports/") || request.path.startsWith("/api/reports/")) {
      response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    }
    next();
  });

  if (options.shutdownGate) app.use(options.shutdownGate);

  const largeJson = express.json({ limit: "1mb" });
  const standardJson = express.json({ limit: "16kb" });
  const standardForm = express.urlencoded({ extended: false, limit: "16kb" });
  const standardBody: RequestHandler = (request, response, next) => {
    standardJson(request, response, (jsonError) => {
      if (jsonError) {
        next(jsonError);
        return;
      }
      standardForm(request, response, next);
    });
  };
  app.use((request, response, next) => {
    const route = bodyRoute(request);
    if (!route) {
      next();
      return;
    }
    if (!route.large) {
      standardBody(request, response, next);
      return;
    }
    largeJson(request, response, (largeError) => {
      if (largeError) {
        next(largeError);
        return;
      }
      standardBody(request, response, next);
    });
  });
  for (const registerRoutes of options.routeRegistrars ?? []) registerRoutes(app);
  app.use(bodyParserError);
  app.use(apiErrorBoundary);
  return app;
}
