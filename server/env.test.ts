import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { loadConfig } from "./env.js";

const mysqlCaPath = "/tmp/toss-portfolio-lens-env-test-ca.pem";
const postgresCaPath = "/tmp/toss-portfolio-lens-env-test-postgres-ca.pem";
const mcpClientSecretPath = "/tmp/toss-portfolio-lens-env-test-mcp-client";
const mcpSigningKeyPath = "/tmp/toss-portfolio-lens-env-test-mcp-key";

describe("database environment configuration", () => {
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    process.env = {
      CLIENT_ID: "client-id",
      CLIENT_SECRET: "client-secret",
      DASHBOARD_PASSWORD: "dashboard-password-long",
      SESSION_SECRET: "session-secret-with-at-least-32-characters",
    };
  });

  afterEach(() => {
    rmSync(mysqlCaPath, { force: true });
    rmSync(postgresCaPath, { force: true });
    rmSync(mcpClientSecretPath, { force: true });
    rmSync(mcpSigningKeyPath, { force: true });
    process.env = { ...originalEnvironment };
    vi.restoreAllMocks();
  });

  it("DB_PROVIDER가 없으면 SQLite를 기본값으로 사용한다", () => {
    const config = loadConfig();
    expect(config).toMatchObject({
      tossApiAuthMode: "oauth_client_credentials",
      clientId: "client-id",
      clientSecret: "client-secret",
      tossApiBaseUrl: "https://openapi.tossinvest.com",
      dbProvider: "sqlite",
    });
    expect(config.mysql).toBeUndefined();
    expect(config.databasePath).toBe("./data/portfolio-history.sqlite");
    expect(config.mcp).toMatchObject({ enabled: false, authMode: "oauth" });
    expect(config.compute).toMatchObject({
      executionMode: "rust_socket",
      resultPollMs: 250,
      resultDeadlineMs: 300_000,
    });
    expect(config.kisExchangeRate).toBeUndefined();
    expect(config.scalping).toMatchObject({
      enabled: false,
      minimumTopCount: 5,
      maximumTopCount: 50,
      ai: {
        url: "ws://ai-worker:8765/ws/scalping-ai/v1",
        authTokenFile: "/run/ai-auth/token",
        connectTimeoutMs: 10_000,
        reconnectBaseMs: 250,
        reconnectMaxMs: 10_000,
        maximumInFlight: 4,
        maximumBatchSize: 50,
        maximumRequestBytes: 64 * 1024 * 1024,
        maximumResponseBytes: 128 * 1024 * 1024,
      },
      simulation: {
        maximumDurationMinutes: 390,
        decisionIntervalMinutes: 5,
        maximumActiveSessions: 2,
        selectionMaximumAttempts: 3,
        selectionRetryDelayMs: 15_000,
      },
    });
  });

  it("단타 기능은 provider 실측 한도를 명시해야만 활성화한다", () => {
    process.env.SCALPING_ENABLED = "true";
    expect(() => loadConfig()).toThrow("KI_APP_KEY");

    Object.assign(process.env, {
      KI_APP_KEY: "kis-key",
      KI_APP_SECRET: "kis-secret",
      TOSS_SCALPING_RANKING_MIN_INTERVAL_MS: "100",
      TOSS_SCALPING_MARKET_DATA_MIN_INTERVAL_MS: "100",
      TOSS_SCALPING_CHART_MIN_INTERVAL_MS: "200",
      TOSS_SCALPING_STOCK_MIN_INTERVAL_MS: "200",
      TOSS_SCALPING_MARKET_INFO_MIN_INTERVAL_MS: "500",
      TOSS_SCALPING_RANKING_MAX_COUNT: "100",
      TOSS_SCALPING_PRICE_BATCH_SIZE: "200",
      TOSS_SCALPING_CANDLE_MAX_COUNT: "200",
      TOSS_SCALPING_TRADE_MAX_COUNT: "50",
      KI_SCALPING_REST_REQUEST_INTERVAL_MS: "600",
      KI_SCALPING_WS_MAX_SUBSCRIPTIONS: "100",
      KI_SCALPING_WS_SUBSCRIBE_INTERVAL_MS: "100",
      SCALPING_MINIMUM_VOLUME: "10000",
      SCALPING_MINIMUM_TRADING_AMOUNT: "100000000",
      SCALPING_US_MINIMUM_TRADING_AMOUNT: "2000000",
      SCALPING_MAXIMUM_SPREAD_BPS: "50",
      SCALPING_WEIGHT_REALIZED_VOLATILITY: "25",
      SCALPING_WEIGHT_NORMALIZED_ATR: "20",
      SCALPING_WEIGHT_DAY_RANGE: "15",
      SCALPING_WEIGHT_BOLLINGER_EXPANSION: "10",
      SCALPING_WEIGHT_RELATIVE_VOLUME: "15",
      SCALPING_WEIGHT_TRADING_AMOUNT: "10",
      SCALPING_WEIGHT_SPREAD: "5",
      AI_MAX_REQUEST_BYTES: "33554432",
      AI_MAX_RESPONSE_BYTES: "67108864",
      AI_COMPUTE_AUTH_TOKEN_FILE: "/run/secrets/test-scalping-ai-token",
    });
    expect(loadConfig().scalping).toMatchObject({
      enabled: true,
      toss: {
        rankingMaximumCount: 100,
        pricesBatchSize: 200,
        rateLimits: {
          ranking: { minimumIntervalMs: 100 }, chart: { minimumIntervalMs: 200 },
          market_info: { minimumIntervalMs: 500 },
        },
      },
      kisRest: { requestIntervalMs: 600 },
      kisWebSocket: { maxSubscriptions: 100, subscribeIntervalMs: 100 },
      realtimeAnalysisDebounceMs: 250,
      scanner: {
        minimumVolume: 10_000,
        minimumTradingAmount: 100_000_000,
        usMinimumTradingAmount: 2_000_000,
        maximumSpreadBps: 50,
      },
      service: {
        workspaceBarLimit: 4_900,
        usWorkspaceBarLimit: 8_640,
        workspaceChartBarLimit: 1_000,
        candlePageSize: 200,
        forecastMinimumBars: 64,
        forecastMaximumBars: 512,
        preMarketOpenMinuteKst: 480,
        preMarketCloseMinuteKst: 530,
        sessionOpenMinuteKst: 540,
        sessionCloseMinuteKst: 930,
        afterMarketOpenMinuteKst: 940,
        afterMarketCloseMinuteKst: 1_200,
      },
      ai: { maximumRequestBytes: 33_554_432, maximumResponseBytes: 67_108_864 },
      simulation: {
        maximumDurationMinutes: 390,
        decisionIntervalMinutes: 5,
        maximumActiveSessions: 2,
      },
    });

    process.env.SCALPING_SIMULATION_MAX_DURATION_MINUTES = "720";
    process.env.SCALPING_SIMULATION_DECISION_INTERVAL_MINUTES = "15";
    process.env.SCALPING_SIMULATION_MAX_ACTIVE_SESSIONS = "3";
    process.env.SCALPING_SIMULATION_SELECTION_MAX_ATTEMPTS = "4";
    process.env.SCALPING_SIMULATION_SELECTION_RETRY_DELAY_MS = "20000";
    expect(loadConfig().scalping.simulation).toEqual({
      maximumDurationMinutes: 720,
      decisionIntervalMinutes: 15,
      maximumActiveSessions: 3,
      selectionMaximumAttempts: 4,
      selectionRetryDelayMs: 20_000,
    });
    process.env.SCALPING_SIMULATION_MAX_DURATION_MINUTES = "1441";
    expect(() => loadConfig()).toThrow("SCALPING_SIMULATION_MAX_DURATION_MINUTES");
    delete process.env.SCALPING_SIMULATION_MAX_DURATION_MINUTES;
    delete process.env.SCALPING_SIMULATION_DECISION_INTERVAL_MINUTES;
    delete process.env.SCALPING_SIMULATION_MAX_ACTIVE_SESSIONS;
    delete process.env.SCALPING_SIMULATION_SELECTION_MAX_ATTEMPTS;
    delete process.env.SCALPING_SIMULATION_SELECTION_RETRY_DELAY_MS;

    process.env.KI_SCALPING_REST_ENV = "demo";
    process.env.KI_SCALPING_WS_ENV = "real";
    expect(loadConfig().scalping).toMatchObject({
      enabled: true,
      kisRest: { environment: "demo" },
      kisWebSocket: { environment: "real" },
    });
    process.env.KI_SCALPING_REST_ENV = "invalid";
    expect(() => loadConfig()).toThrow("KI_SCALPING_REST_ENV는 demo 또는 real");
    delete process.env.KI_SCALPING_REST_ENV;
    delete process.env.KI_SCALPING_WS_ENV;

    process.env.KI_SCALPING_WS_MAX_SUBSCRIPTIONS = "40";
    expect(loadConfig().scalping).toMatchObject({
      enabled: true,
      maximumTopCount: 13,
      scanner: { maximumTopCount: 13 },
      service: { maximumTopCount: 13, maximumSubscriptions: 40 },
      kisWebSocket: { maxSubscriptions: 40 },
    });
    process.env.KI_SCALPING_WS_MAX_SUBSCRIPTIONS = "100";

    process.env.SCALPING_WORKSPACE_BAR_LIMIT = "4899";
    expect(() => loadConfig()).toThrow("NXT 통합 세션 60분봉 분석 60개를 장중 보장하기 위해 최소 4900");
    process.env.SCALPING_WORKSPACE_BAR_LIMIT = "4900";
    process.env.SCALPING_MINIMUM_ANALYSIS_BARS = "61";
    expect(() => loadConfig()).toThrow("60분봉 분석 61개를 장중 보장하기 위해 최소 5600");
    process.env.SCALPING_MINIMUM_ANALYSIS_BARS = "1";
    process.env.SCALPING_WORKSPACE_BAR_LIMIT = "4199";
    expect(() => loadConfig()).toThrow("NXT 통합 세션 RVOL 5개 이전 세션을 위해 최소 4200");
    process.env.SCALPING_WORKSPACE_BAR_LIMIT = "4200";
    process.env.SCALPING_RVOL_LOOKBACK_SESSIONS = "6";
    expect(() => loadConfig()).toThrow("최소 4900");
    process.env.SCALPING_RVOL_LOOKBACK_SESSIONS = "5";
    process.env.SCALPING_MINIMUM_ANALYSIS_BARS = "60";
    process.env.SCALPING_WORKSPACE_BAR_LIMIT = "4900";
    process.env.SCALPING_US_WORKSPACE_BAR_LIMIT = "8639";
    expect(() => loadConfig()).toThrow("미국 확장 세션 RVOL 5개 이전 세션을 위해 최소 8640");
    process.env.SCALPING_US_WORKSPACE_BAR_LIMIT = "8640";
    process.env.SCALPING_RVOL_LOOKBACK_SESSIONS = "6";
    expect(() => loadConfig()).toThrow("미국 확장 세션 RVOL 6개 이전 세션을 위해 최소 10080");
    process.env.SCALPING_RVOL_LOOKBACK_SESSIONS = "5";

    process.env.TOSS_SCALPING_CANDLE_MAX_COUNT = "201";
    expect(() => loadConfig()).toThrow("TOSS_SCALPING_CANDLE_MAX_COUNT");
    process.env.TOSS_SCALPING_CANDLE_MAX_COUNT = "200";

    process.env.SCALPING_SESSION_OPEN_KST = "16:00";
    expect(() => loadConfig()).toThrow("SCALPING_SESSION_OPEN_KST는 SCALPING_SESSION_CLOSE_KST보다 빨라야");

    process.env.SCALPING_SESSION_OPEN_KST = "09:00";
    process.env.SCALPING_NXT_AFTER_MARKET_OPEN_KST = "15:20";
    expect(() => loadConfig()).toThrow("must not overlap");
    process.env.SCALPING_NXT_AFTER_MARKET_OPEN_KST = "15:40";
    process.env.AI_MAX_RESPONSE_BYTES = "513";
    expect(() => loadConfig()).toThrow("AI_MAX_RESPONSE_BYTES");

    process.env.AI_MAX_RESPONSE_BYTES = "67108864";
    process.env.KI_SCALPING_WS_MAX_SUBSCRIPTIONS = "14";
    expect(() => loadConfig()).toThrow("최소 표시 종목 5개의 미국 표준 체결·데이 체결·1호가 3개 구독");

    process.env.KI_SCALPING_WS_MAX_SUBSCRIPTIONS = "100";
    process.env.AI_COMPUTE_MAX_BATCH_SIZE = "32";
    expect(() => loadConfig()).toThrow("실제 적용되는 최대 표시 종목 수 이상");
  });

  it("AI WebSocket URL의 local, private opt-in, remote TLS 경계를 검증하고 비활성 시 token file을 읽지 않는다", () => {
    process.env.AI_COMPUTE_AUTH_TOKEN_FILE = "/definitely/missing/scalping-ai-token";
    expect(loadConfig().scalping.ai).toMatchObject({
      url: "ws://ai-worker:8765/ws/scalping-ai/v1",
      authTokenFile: "/definitely/missing/scalping-ai-token",
    });

    process.env.AI_COMPUTE_URL = "ws://10.20.30.40:8765/ws/scalping-ai/v1";
    expect(() => loadConfig()).toThrow("AI_COMPUTE_ALLOW_INSECURE_PRIVATE_WS=true");
    process.env.AI_COMPUTE_ALLOW_INSECURE_PRIVATE_WS = "true";
    expect(loadConfig().scalping.ai.url).toBe("ws://10.20.30.40:8765/ws/scalping-ai/v1");

    process.env.AI_COMPUTE_URL = "ws://203.0.113.10:8765/ws/scalping-ai/v1";
    expect(() => loadConfig()).toThrow("원격 AI_COMPUTE_URL은 wss://");
    process.env.AI_COMPUTE_URL = "wss://gpu.example.test:8765/ws/scalping-ai/v1";
    expect(loadConfig().scalping.ai.url).toBe("wss://gpu.example.test:8765/ws/scalping-ai/v1");

    process.env.AI_COMPUTE_URL = "wss://user:password@gpu.example.test:8765/ws/scalping-ai/v1";
    expect(() => loadConfig()).toThrow("/ws/scalping-ai/v1 경로");
    process.env.AI_COMPUTE_URL = "wss://gpu.example.test:8765/ws/scalping-ai/v1";
    process.env.AI_COMPUTE_AUTH_TOKEN_FILE = "relative/token";
    expect(() => loadConfig()).toThrow("절대 경로");
  });

  it("한국투자증권 환율 폴백 설정을 검증한다", () => {
    Object.assign(process.env, {
      KI_APP_KEY: "kis-app-key",
      KI_APP_SECRET: "kis-app-secret",
    });
    expect(loadConfig().kisExchangeRate).toEqual({
      appKey: "kis-app-key",
      appSecret: "kis-app-secret",
      environment: "demo",
      requestIntervalMs: 600,
      timeoutMs: 15_000,
    });

    process.env.KI_API_ENV = "real";
    process.env.KI_API_REQUEST_INTERVAL_MS = "750";
    process.env.KI_API_TIMEOUT_MS = "20000";
    expect(loadConfig().kisExchangeRate).toMatchObject({
      environment: "real",
      requestIntervalMs: 750,
      timeoutMs: 20_000,
    });

    delete process.env.KI_APP_SECRET;
    expect(() => loadConfig()).toThrow("KI_APP_KEY와 KI_APP_SECRET은 함께 설정");
    process.env.KI_APP_SECRET = "kis-app-secret";
    process.env.KI_API_ENV = "unsupported";
    expect(() => loadConfig()).toThrow("KI_API_ENV는 demo 또는 real");
  });

  it("external compute는 PostgreSQL에서만 허용하고 실행 제한값을 검증한다", () => {
    process.env.EXECUTION_MODE = "external";
    expect(() => loadConfig()).toThrow("EXECUTION_MODE=external은 DB_PROVIDER=postgresql");

    Object.assign(process.env, {
      DB_PROVIDER: "postgresql",
      POSTGRES_URL: "postgresql://portfolio:password@postgres.internal:5432/portfolio_lens",
      PYTHON_WORKER_RESULT_POLL_MS: "50",
      PYTHON_WORKER_RESULT_DEADLINE_MS: "120000",
      MCP_MAX_QUEUED_RUNS: "8",
      MCP_RUN_DEADLINE_MS: "90000",
    });
    expect(loadConfig()).toMatchObject({
      compute: {
        executionMode: "external",
        resultPollMs: 50,
        resultDeadlineMs: 120_000,
      },
      mcp: { maxQueuedRuns: 8, runDeadlineMs: 90_000 },
    });

    process.env.RUST_WORKER_RESULT_POLL_MS = "75";
    process.env.RUST_WORKER_RESULT_DEADLINE_MS = "180000";
    expect(loadConfig().compute).toMatchObject({ resultPollMs: 75, resultDeadlineMs: 180_000 });

    process.env.EXECUTION_MODE = "process";
    expect(() => loadConfig()).toThrow("EXECUTION_MODE는 inline, rust_socket 또는 external");
  });

  it("정적 Bearer 모드에서는 OAuth 자격증명 없이 호환 API를 설정한다", () => {
    delete process.env.CLIENT_ID;
    delete process.env.CLIENT_SECRET;
    Object.assign(process.env, {
      TOSS_API_AUTH_MODE: "static_bearer",
      TOSS_API_BEARER_TOKEN: "local-read-only-token",
      TOSS_API_BASE_URL: "https://tpl.uaysk.com/",
    });

    expect(loadConfig()).toMatchObject({
      tossApiAuthMode: "static_bearer",
      tossApiBearerToken: "local-read-only-token",
      tossApiBaseUrl: "https://tpl.uaysk.com",
    });
  });

  it("인증 모드별 필수값과 허용값을 검증한다", () => {
    delete process.env.CLIENT_ID;
    expect(() => loadConfig()).toThrow("필수 환경 변수 CLIENT_ID");

    process.env.TOSS_API_AUTH_MODE = "static_bearer";
    delete process.env.CLIENT_SECRET;
    expect(() => loadConfig()).toThrow("필수 환경 변수 TOSS_API_BEARER_TOKEN");

    process.env.TOSS_API_AUTH_MODE = "unsupported";
    expect(() => loadConfig()).toThrow("TOSS_API_AUTH_MODE는 oauth_client_credentials 또는 static_bearer");
  });

  it("DASHBOARD_PASSWORD는 비어 있지 않으면 길이와 관계없이 허용한다", () => {
    process.env.DASHBOARD_PASSWORD = "short";
    expect(loadConfig().dashboardPassword).toBe("short");

    process.env.DASHBOARD_PASSWORD = "   ";
    expect(() => loadConfig()).toThrow("필수 환경 변수 DASHBOARD_PASSWORD");
  });

  it("개별 MySQL 값을 모두 설정하면 연결 구성을 만든다", () => {
    writeFileSync(mysqlCaPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");
    Object.assign(process.env, {
      DB_PROVIDER: "mysql",
      MYSQL_HOST: "mysql.internal",
      MYSQL_PORT: "3307",
      MYSQL_USER: "portfolio",
      MYSQL_PASSWORD: "database-password",
      MYSQL_DATABASE: "portfolio_lens",
      MYSQL_CONNECT_TIMEOUT_MS: "2500",
      MYSQL_SSL: "true",
      MYSQL_SSL_CA_PATH: mysqlCaPath,
      MYSQL_SSL_REJECT_UNAUTHORIZED: "false",
    });

    expect(loadConfig().mysql).toEqual({
      host: "mysql.internal",
      port: 3307,
      user: "portfolio",
      password: "database-password",
      database: "portfolio_lens",
      connectTimeoutMs: 2500,
      ssl: {
        rejectUnauthorized: false,
        ca: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
      },
    });
    expect(loadConfig().dbProvider).toBe("mysql");
  });

  it("DB_PROVIDER=mysql에서 MYSQL_URL을 지원하고 일부 설정은 거부한다", () => {
    process.env.DB_PROVIDER = "mysql";
    process.env.MYSQL_URL = "mysql://portfolio:p%40ss@mysql.internal:3306/portfolio_lens";
    expect(loadConfig().mysql).toMatchObject({
      host: "mysql.internal",
      port: 3306,
      user: "portfolio",
      password: "p@ss",
      database: "portfolio_lens",
    });

    delete process.env.MYSQL_URL;
    process.env.MYSQL_HOST = "mysql.internal";
    expect(() => loadConfig()).toThrow("MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE가 모두 필요합니다");
  });

  it("선택한 DB의 연결 설정이 없으면 시작하지 않는다", () => {
    process.env.DB_PROVIDER = "mysql";
    expect(() => loadConfig()).toThrow("DB_PROVIDER=mysql이면 유효한 MySQL 연결 설정");

    process.env.DB_PROVIDER = "postgresql";
    expect(() => loadConfig()).toThrow("DB_PROVIDER=postgresql이면 유효한 PostgreSQL 연결 설정");
  });

  it("개별 PostgreSQL 값과 TLS CA를 연결 구성으로 만든다", () => {
    writeFileSync(postgresCaPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");
    Object.assign(process.env, {
      DB_PROVIDER: "postgresql",
      POSTGRES_HOST: "postgres.internal",
      POSTGRES_PORT: "5433",
      POSTGRES_USER: "portfolio",
      POSTGRES_PASSWORD: "database-password",
      POSTGRES_DATABASE: "portfolio_lens",
      POSTGRES_CONNECT_TIMEOUT_MS: "2500",
      POSTGRES_SSL: "true",
      POSTGRES_SSL_CA_PATH: postgresCaPath,
      POSTGRES_SSL_REJECT_UNAUTHORIZED: "false",
    });

    expect(loadConfig().postgres).toEqual({
      host: "postgres.internal",
      port: 5433,
      user: "portfolio",
      password: "database-password",
      database: "portfolio_lens",
      connectTimeoutMs: 2500,
      ssl: {
        rejectUnauthorized: false,
        ca: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
      },
    });
    expect(loadConfig().dbProvider).toBe("postgresql");
  });

  it("DB_PROVIDER=postgresql에서 POSTGRES_URL을 지원하고 일부 설정은 거부한다", () => {
    process.env.DB_PROVIDER = "postgresql";
    process.env.POSTGRES_URL = "postgresql://portfolio:p%40ss@postgres.internal:5432/portfolio_lens";
    expect(loadConfig().postgres).toMatchObject({
      host: "postgres.internal",
      port: 5432,
      user: "portfolio",
      password: "p@ss",
      database: "portfolio_lens",
    });

    delete process.env.POSTGRES_URL;
    process.env.POSTGRES_HOST = "postgres.internal";
    expect(() => loadConfig()).toThrow("POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE가 모두 필요합니다");
  });

  it("지원하지 않는 DB_PROVIDER 값을 거부한다", () => {
    process.env.DB_PROVIDER = "postgres";
    expect(() => loadConfig()).toThrow("DB_PROVIDER는 sqlite, mysql, postgresql 중 하나");
  });

  it("공개 URL과 OpenAI 보고서 설정을 정규화한다", () => {
    Object.assign(process.env, {
      PUBLIC_APP_URL: "tpl.uaysk.com/",
      OPENAI_API_ENDPOINT: "https://api.openai.com/v1/",
      OPENAI_API_KEY: "test-openai-key",
      OPENAI_MODEL: "test-model",
      OPENAI_TIMEOUT_MS: "45000",
      REPORTS_PATH: "/tmp/portfolio-reports",
    });
    const config = loadConfig();
    expect(config.publicAppUrl).toBe("https://tpl.uaysk.com");
    expect(config.openAi).toEqual({
      endpoint: "https://api.openai.com/v1",
      apiKey: "test-openai-key",
      model: "test-model",
      timeoutMs: 45_000,
    });
    expect(config.reportStorage).toEqual({ kind: "local", directory: "/tmp/portfolio-reports" });
  });

  it("Stockholm Bedrock Kimi K2.5 보고서 설정을 선택한다", () => {
    Object.assign(process.env, {
      REPORT_AI_PROVIDER: "bedrock",
      BEDROCK_REGION: "eu-north-1",
      BEDROCK_MODEL_ID: "moonshotai.kimi-k2.5",
      BEDROCK_TIMEOUT_MS: "90000",
    });
    const config = loadConfig();
    expect(config.bedrock).toEqual({
      region: "eu-north-1",
      modelId: "moonshotai.kimi-k2.5",
      timeoutMs: 90_000,
    });
    expect(config.openAi).toBeUndefined();
  });

  it("지원하지 않는 AI 보고서 공급자를 거부한다", () => {
    process.env.REPORT_AI_PROVIDER = "unsupported";
    expect(() => loadConfig()).toThrow("REPORT_AI_PROVIDER는 openai 또는 bedrock");
  });

  it("S3_BUCKET이 있으면 S3 보고서 저장소를 선택한다", () => {
    Object.assign(process.env, {
      S3_BUCKET: "portfolio-reports",
      S3_REGION: "ap-northeast-2",
      S3_PREFIX: "/lens/reports/",
      S3_ENDPOINT: "http://minio.internal:9000/",
      S3_ACCESS_KEY_ID: "access-key",
      S3_SECRET_ACCESS_KEY: "secret-key",
    });
    expect(loadConfig().reportStorage).toEqual({
      kind: "s3",
      bucket: "portfolio-reports",
      region: "ap-northeast-2",
      prefix: "lens/reports",
      endpoint: "http://minio.internal:9000",
      forcePathStyle: true,
      credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
    });
  });

  it("MCP OAuth를 활성화하면 secret 파일과 제한값을 읽는다", () => {
    writeFileSync(mcpClientSecretPath, "client-secret-value\n");
    writeFileSync(mcpSigningKeyPath, "private-key-value\n");
    Object.assign(process.env, {
      MCP_ENABLED: "true",
      MCP_AUTH_MODE: "oauth",
      MCP_RESOURCE_URL: "https://portfolio.example/mcp",
      MCP_OAUTH_ISSUER: "https://portfolio.example",
      MCP_OAUTH_CLIENT_ID: "chatgpt-client",
      MCP_OAUTH_REDIRECT_URI: "https://chatgpt.example/oauth/callback",
      MCP_OAUTH_CLIENT_SECRET_FILE: mcpClientSecretPath,
      MCP_OAUTH_SIGNING_KEY_FILE: mcpSigningKeyPath,
      MCP_MAX_ASSETS: "12",
      MCP_MAX_CANDIDATE_BUDGET: "2500",
    });
    expect(loadConfig().mcp).toMatchObject({
      enabled: true,
      authMode: "oauth",
      resourceUrl: "https://portfolio.example/mcp",
      maxAssets: 12,
      maxCandidateBudget: 2_500,
      oauth: {
        issuer: "https://portfolio.example",
        clientId: "chatgpt-client",
        clientSecret: "client-secret-value",
        signingPrivateKeyPem: "private-key-value",
        autoApprove: false,
        accessTokenTtlSeconds: 3_600,
      },
    });
  });

  it("활성 OAuth 설정 누락, 운영 HTTP, 운영 무인증 모드를 fail-closed로 거부한다", () => {
    process.env.MCP_ENABLED = "true";
    expect(() => loadConfig()).toThrow("MCP_OAUTH_ISSUER");

    writeFileSync(mcpClientSecretPath, "client-secret-value\n");
    writeFileSync(mcpSigningKeyPath, "private-key-value\n");
    Object.assign(process.env, {
      NODE_ENV: "production",
      MCP_RESOURCE_URL: "http://portfolio.example/mcp",
      MCP_OAUTH_ISSUER: "http://portfolio.example",
      MCP_OAUTH_CLIENT_ID: "chatgpt-client",
      MCP_OAUTH_REDIRECT_URI: "http://portfolio.example/callback",
      MCP_OAUTH_CLIENT_SECRET_FILE: mcpClientSecretPath,
      MCP_OAUTH_SIGNING_KEY_FILE: mcpSigningKeyPath,
    });
    expect(() => loadConfig()).toThrow("HTTPS");

    Object.assign(process.env, { MCP_AUTH_MODE: "none", HOST: "127.0.0.1" });
    expect(() => loadConfig()).toThrow("production이 아닌 loopback");
  });

  it("개발 loopback에서만 명시적인 MCP_AUTH_MODE=none을 허용한다", () => {
    Object.assign(process.env, {
      MCP_ENABLED: "true",
      MCP_AUTH_MODE: "none",
      HOST: "127.0.0.1",
      NODE_ENV: "development",
      MCP_RESOURCE_URL: "http://127.0.0.1:3200/mcp",
    });
    expect(loadConfig().mcp).toMatchObject({ enabled: true, authMode: "none" });
  });
});
