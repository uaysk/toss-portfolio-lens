import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";

export type CreateAppOptions = {
  trustProxy: readonly string[];
  oauthCallbackOrigin?: string;
  shutdownGate?: RequestHandler;
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

function bodyRoute(request: Request): BodyRoute | undefined {
  const requestPath = request.path.length > 1 && request.path.endsWith("/")
    ? request.path.slice(0, -1)
    : request.path;
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

export function createApp(options: CreateAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxy.length) app.set("trust proxy", [...options.trustProxy]);

  app.use((request, response, next) => {
    const formAction = request.path === "/oauth/authorize" && options.oauthCallbackOrigin
      ? `'self' ${options.oauthCallbackOrigin}`
      : "'self'";
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action ${formAction}`,
    );
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
  return app;
}
