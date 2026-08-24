export class ResponseBodyLimitError extends Error {
  constructor(readonly maximumBytes: number) {
    super(`Response body exceeded the ${maximumBytes}-byte limit.`);
    this.name = "ResponseBodyLimitError";
  }
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Read a Fetch response without allowing a chunked body to grow without bound. */
export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("maximumBytes must be a positive safe integer.");
  }

  if ((contentLength(response) ?? 0) > maximumBytes) {
    const error = new ResponseBodyLimitError(maximumBytes);
    await response.body?.cancel(error).catch(() => undefined);
    throw error;
  }

  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        const error = new ResponseBodyLimitError(maximumBytes);
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}
