import type { App } from "./context";

export const encoder = new TextEncoder();
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason = "transfer_failed",
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}
export const commonHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};
export const streamHeaders = { ...commonHeaders, "x-accel-buffering": "no" };

export function json(data: unknown, status = 200) {
  const body = JSON.stringify(data);
  const headers = {
    ...commonHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
  };
  return new Response(body, { status, headers });
}
export function notFound() {
  return new Response("Not found", { status: 404, headers: commonHeaders });
}
/** Carries an HttpError's Retry-After (a 429 limit, a 503 restart) onto the response that reports it. */
export function withRetryAfter(response: Response, error: unknown) {
  if (error instanceof HttpError && error.retryAfter) response.headers.set("retry-after", String(error.retryAfter));
  return response;
}
export function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
/** Bookkeeping (saving, host state, status) must not stop the cleanup, answer or timer around it; a failure such as a full disk is logged. */
export function attempt(step: () => void) {
  try {
    step();
  } catch (error) {
    console.error("Share bookkeeping failed:", asError(error).message);
  }
}
export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, `${label} must be an object`);
  return value as Record<string, unknown>;
}
export function headerSize(value: string | null, label: string): number | undefined {
  if (value === null) return;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new HttpError(400, `${label} must be a nonnegative safe integer`, "size_mismatch");
  return Number(value);
}
export async function readJson(app: App, request: Request) {
  // A cross-site form or text/plain fetch can't send application/json without a CORS preflight, which writes never pass.
  if (!/^application\/json\s*(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new HttpError(415, "Send JSON with Content-Type: application/json", "unsupported_media_type");
  }
  const length = headerSize(request.headers.get("content-length"), "Content-Length");
  if (length !== undefined && length > app.config.maxMetadataBytes)
    throw new HttpError(413, "Metadata body is too large");
  if (!request.body) throw new HttpError(400, "Expected a JSON body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Control bodies are small, so a slow one is a held connection, not a transfer; uploads never come through here.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new HttpError(408, "The request body took too long to arrive", "body_timeout")),
      app.config.controlBodyTimeout,
    );
    timer.unref();
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), late]);
      if (done) break;
      size += value.byteLength;
      if (size > app.config.maxMetadataBytes) throw new HttpError(413, "Metadata body is too large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new HttpError(400, "Expected valid JSON");
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* a cancelled read may still hold the lock */
    }
  }
}
