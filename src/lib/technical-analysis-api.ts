import {
  unwrapTechnicalAnalysisPayload,
  type TechnicalAnalysisPayload,
  type TechnicalAnalysisRequest,
  type TechnicalInstrumentChoice,
  type TechnicalTradeMarkersPayload,
} from "./technical-analysis";

type FetchImplementation = typeof fetch;

type SearchResponseInstrument = {
  symbol?: unknown;
  name?: unknown;
  market?: unknown;
  currency?: unknown;
  assetType?: unknown;
  securityType?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

export class TechnicalAnalysisApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TechnicalAnalysisApiError";
    this.status = status;
  }
}

export function technicalApiErrorMessage(value: unknown, fallback: string): string {
  const outer = record(value);
  const error = record(outer.error);
  const message = error.message ?? outer.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

export function parseTechnicalSearchResults(payload: unknown): TechnicalInstrumentChoice[] {
  const outer = record(payload);
  const result = record(outer.result);
  const raw = Array.isArray(result.instruments)
    ? result.instruments
    : Array.isArray(outer.instruments) ? outer.instruments : [];
  return raw.flatMap((item): TechnicalInstrumentChoice[] => {
    const candidate = item as SearchResponseInstrument;
    if (typeof candidate.symbol !== "string") return [];
    const symbol = candidate.symbol.trim().toUpperCase();
    if (!symbol) return [];
    return [{
      symbol,
      name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : symbol,
      market: typeof candidate.market === "string" ? candidate.market : "",
      currency: candidate.currency === "USD" ? "USD" : "KRW",
      assetType: typeof candidate.assetType === "string"
        ? candidate.assetType
        : typeof candidate.securityType === "string" ? candidate.securityType : undefined,
    }];
  });
}

export function parseTechnicalTradeMarkers(payload: unknown): TechnicalTradeMarkersPayload | undefined {
  const outer = record(payload);
  const result = record(outer.result);
  const candidate = result.markers ? result : outer;
  return Array.isArray(candidate.markers)
    ? candidate as unknown as TechnicalTradeMarkersPayload
    : undefined;
}

export async function searchTechnicalInstruments(
  query: string,
  options: { signal?: AbortSignal; fetchImpl?: FetchImplementation } = {},
): Promise<TechnicalInstrumentChoice[]> {
  const response = await (options.fetchImpl ?? fetch)("/api/portfolio/tools/search_instruments", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit: 12 }),
    signal: options.signal,
  });
  const payload = await responseJson(response);
  if (!response.ok) {
    throw new TechnicalAnalysisApiError(
      response.status,
      technicalApiErrorMessage(payload, "종목을 검색하지 못했습니다."),
    );
  }
  return parseTechnicalSearchResults(payload);
}

export async function requestTechnicalAnalysis(
  request: TechnicalAnalysisRequest,
  options: {
    signal?: AbortSignal;
    fetchImpl?: FetchImplementation;
    failureMessage: string;
    invalidResponseMessage: string;
  },
): Promise<TechnicalAnalysisPayload> {
  const response = await (options.fetchImpl ?? fetch)("/api/portfolio/tools/analyze_technical_signals", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: options.signal,
  });
  const payload = await responseJson(response);
  if (!response.ok) {
    throw new TechnicalAnalysisApiError(
      response.status,
      technicalApiErrorMessage(payload, options.failureMessage),
    );
  }
  const analysis = unwrapTechnicalAnalysisPayload(payload);
  if (!analysis) throw new TechnicalAnalysisApiError(response.status, options.invalidResponseMessage);
  return analysis;
}

export async function requestTechnicalTradeMarkers(
  input: { accountId: string; fromDate: string; toDate: string; symbols: string[] },
  options: { signal?: AbortSignal; fetchImpl?: FetchImplementation } = {},
): Promise<TechnicalTradeMarkersPayload> {
  const params = new URLSearchParams({
    account: input.accountId,
    from: input.fromDate,
    to: input.toDate,
    symbols: input.symbols.join(","),
  });
  const response = await (options.fetchImpl ?? fetch)(`/api/portfolio/technical/trades?${params.toString()}`, {
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  const payload = await responseJson(response);
  if (!response.ok) {
    throw new TechnicalAnalysisApiError(
      response.status,
      technicalApiErrorMessage(payload, "거래 marker를 불러오지 못했습니다. 가격 차트와 지표는 정상 표시됩니다."),
    );
  }
  const markers = parseTechnicalTradeMarkers(payload);
  if (!markers) {
    throw new TechnicalAnalysisApiError(
      response.status,
      technicalApiErrorMessage(
        payload,
        "거래 marker를 불러오지 못했습니다. 가격 차트와 지표는 정상 표시됩니다.",
      ),
    );
  }
  return markers;
}
