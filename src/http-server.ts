import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

type HttpOptions = {
  hostname: string;
  port: number;
  maxRequestBodySize: number;
  fetch: (request: Request) => Response | Promise<Response>;
  error?: (error: Error) => Response;
  clientKey?: (request: Request) => string;
  maxDiscards?: number;
  maxDiscardsPerClient?: number;
};

const peerAddresses = new WeakMap<Request, string>();
const abandonedResponses = new WeakSet<Response>();
type RequestLifecycle = { finished: boolean; callbacks: Set<() => void> };
const requestLifecycles = new WeakMap<Request, RequestLifecycle>();
/** Socket provenance is kept out of caller-controlled HTTP headers. */
export function remoteAddress(request: Request) { return peerAddresses.get(request) ?? "unknown"; }
/** Active uploads that lost their consumers must never discard the remaining file in full. */
export function abandonUpload(response: Response) { abandonedResponses.add(response); return response; }
/** Includes ignored-body draining; a live eager creation is still in progress. */
export function onRequestFinished(request: Request, callback: () => void) {
  const lifecycle = requestLifecycles.get(request);
  if (!lifecycle || lifecycle.finished) queueMicrotask(callback);
  else lifecycle.callbacks.add(callback);
}

type DiscardLimits = { active: number; clients: Map<string, number> };

/** Stream Web handlers through node:http, which preserves streaming Content-Length in Bun. */
export async function serveHttp(options: HttpOptions): Promise<{ port: number; stop: (force?: boolean) => Promise<void> }> {
  const sockets = new Set<Socket>();
  const discards: DiscardLimits = { active: 0, clients: new Map() };
  const dispatch = (incoming: IncomingMessage, outgoing: ServerResponse) => {
    void handle(incoming, outgoing, options, discards).catch(() => outgoing.destroy());
  };
  const server = createServer(dispatch);
  // Dispatch before sending Continue: redirect routes must not consume curl's stdin.
  server.on("checkContinue", dispatch);
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 15_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => { server.off("error", reject); resolve(); });
  });
  let stopping: Promise<void> | undefined;
  return {
    port: (server.address() as { port: number }).port,
    stop(force = false) {
      stopping ??= new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (force) for (const socket of sockets) socket.destroy();
      return stopping;
    },
  };
}

function requestUrl(incoming: IncomingMessage): string {
  const host = incoming.headers.host;
  if (!host || /[\s\\/#?@]/.test(host)) throw new Error("Invalid Host");
  const origin = new URL(`http://${host}`);
  const path = incoming.url ?? "/";
  if (!path.startsWith("/")) throw new Error("Invalid request target");
  // Concatenation deliberately preserves a leading // as a path, never a new authority.
  return `${origin.origin}${path}`;
}

function plain(outgoing: ServerResponse, status: number, message: string) {
  if (outgoing.headersSent || outgoing.destroyed) { outgoing.destroy(); return; }
  outgoing.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(message), connection: "close" });
  outgoing.end(message);
}

async function handle(incoming: IncomingMessage, outgoing: ServerResponse, options: HttpOptions, discards: DiscardLimits) {
  const declared = incoming.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > options.maxRequestBodySize)) {
    plain(outgoing, 413, "Request body too large");
    return;
  }
  let url: string;
  try { url = requestUrl(incoming); } catch { plain(outgoing, 400, "Bad request"); return; }

  const abort = new AbortController();
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let bodyEnded = false;
  let bodyCancelled = false;
  let discarding = false;
  let discardTimer: ReturnType<typeof setTimeout> | undefined;
  let finishDiscard: (() => void) | undefined;
  let releaseDiscard: (() => void) | undefined;
  let boundedDiscard = false;
  let discardStartedAtBytes = 0;
  let lastBodyPull = Date.now();
  let lifecycle: RequestLifecycle | undefined;
  let probeDelay = 1000;
  let nextProbeAt = Date.now() + probeDelay;
  let received = 0;
  let responseReader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock"> | undefined;
  let cancelledReader = false;
  const cancelResponse = (reason: unknown) => {
    if (responseReader && !cancelledReader) {
      cancelledReader = true;
      void responseReader.cancel(reason).catch(() => {});
    }
  };
  const failBody = (reason: Error) => {
    clearTimeout(discardTimer);
    finishDiscard?.();
    if (!bodyEnded) { bodyEnded = true; if (!bodyCancelled) bodyController?.error(reason); }
    if (!abort.signal.aborted) abort.abort(reason);
    cancelResponse(reason);
  };
  const onAborted = () => failBody(new Error("Client disconnected"));
  const onRequestError = (error: Error) => failBody(error);
  const onRequestClose = () => { if (!incoming.complete) onAborted(); };
  const onResponseClose = () => { if (!outgoing.writableFinished) onAborted(); cleanup(); };
  const onResponseError = (error: Error) => { failBody(error); outgoing.destroy(); };
  const onData = (chunk: Buffer) => {
    if (!discarding) incoming.pause();
    received += chunk.byteLength;
    if (received > options.maxRequestBodySize) {
      plain(outgoing, 413, "Request body too large");
      failBody(new Error("Request body too large"));
      return;
    }
    if (discarding) {
      if (boundedDiscard && received - discardStartedAtBytes >= 1024 * 1024) finishDiscard?.();
      else if (!boundedDiscard) resetDiscardTimeout();
    }
    else if (!bodyEnded && !bodyCancelled) bodyController!.enqueue(chunk);
  };
  const onEnd = () => {
    clearTimeout(discardTimer);
    finishDiscard?.();
    if (!bodyEnded) { bodyEnded = true; if (!bodyCancelled) bodyController?.close(); }
    if (outgoing.writableFinished) cleanup();
  };
  const cleanup = () => {
    clearTimeout(discardTimer);
    clearInterval(processingTimer);
    releaseDiscard?.(); releaseDiscard = undefined;
    if (lifecycle && !lifecycle.finished) {
      lifecycle.finished = true;
      for (const callback of lifecycle.callbacks) {
        try { callback(); } catch { console.error("Request lifecycle cleanup failed"); }
      }
      lifecycle.callbacks.clear();
    }
    incoming.off("data", onData);
    incoming.off("end", onEnd);
    incoming.off("aborted", onAborted);
    incoming.off("close", onRequestClose);
    // Bun may emit a reset error after the response's close event. Keep the
    // per-request error sink until this request is collected.
    outgoing.off("close", onResponseClose);
    outgoing.off("finish", cleanup);
  };
  const resetDiscardTimeout = () => {
    clearTimeout(discardTimer);
    // Bound stalled ignored bodies without imposing a total transfer deadline.
    discardTimer = setTimeout(() => incoming.destroy(new Error("Request body idle timeout")), 30_000);
    discardTimer.unref();
  };
  // A FIN can sit behind unread eager-upload bytes while IncomingMessage is
  // paused. 103 is understood as informational by nginx (unlike 102). The
  // non-fetching relation has no preload side effect. Back off for live peers.
  const processingTimer = setInterval(() => {
    if (hasBody && !bodyEnded && !outgoing.headersSent && !outgoing.destroyed && !outgoing.writableEnded && Date.now() - lastBodyPull >= 1000 && Date.now() >= nextProbeAt && incoming.httpVersion !== "1.0") {
      try {
        outgoing.writeEarlyHints({ link: "</healthz>; rel=monitor" });
        probeDelay = Math.min(30_000, probeDelay * 2);
        nextProbeAt = Date.now() + probeDelay;
      } catch (error) { failBody(error instanceof Error ? error : new Error("Client disconnected")); }
    }
  }, 1000);
  processingTimer.unref();
  incoming.on("aborted", onAborted);
  incoming.on("error", onRequestError);
  incoming.on("close", onRequestClose);
  outgoing.on("close", onResponseClose);
  outgoing.on("error", onResponseError);
  outgoing.on("finish", cleanup);
  incoming.pause();
  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD" && (declared !== undefined || incoming.headers["transfer-encoding"] !== undefined);
  const body = hasBody ? new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
      incoming.on("data", onData);
      incoming.on("end", onEnd);
    },
    pull() {
      lastBodyPull = Date.now();
      probeDelay = 1000; nextProbeAt = lastBodyPull + probeDelay;
      if (incoming.headers.expect?.toLowerCase() === "100-continue" && !outgoing.headersSent && !outgoing.writableEnded) {
        outgoing.writeContinue();
        delete incoming.headers.expect;
      }
      incoming.resume();
    },
    cancel() { bodyCancelled = true; incoming.pause(); },
  }, { highWaterMark: 0 }) : undefined;

  try {
    const headers = new Headers();
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
    const request = new Request(url, { method: incoming.method, headers, body, signal: abort.signal, duplex: "half" } as RequestInit);
    peerAddresses.set(request, incoming.socket.remoteAddress ?? "unknown");
    lifecycle = { finished: false, callbacks: new Set() };
    requestLifecycles.set(request, lifecycle);
    let response: Response;
    try { response = await options.fetch(request); }
    catch (error) {
      if (abort.signal.aborted || outgoing.writableEnded || outgoing.destroyed) return;
      try { response = options.error?.(error instanceof Error ? error : new Error("Request failed")) ?? new Response("Internal server error", { status: 500 }); }
      catch { response = new Response("Internal server error", { status: 500 }); }
    }
    if (abort.signal.aborted || outgoing.writableEnded || outgoing.destroyed) {
      void response.body?.cancel(abort.signal.reason).catch(() => {});
      return;
    }
    const expectContinue = incoming.headers.expect?.toLowerCase() === "100-continue";
    boundedDiscard = abandonedResponses.has(response) || response.status >= 400;
    if (hasBody && !bodyEnded && !expectContinue) {
      const key = options.clientKey?.(request) ?? remoteAddress(request);
      const count = discards.clients.get(key) ?? 0;
      if (discards.active >= (options.maxDiscards ?? 64) || count >= (options.maxDiscardsPerClient ?? 8)) {
        void response.body?.cancel().catch(() => {});
        response = new Response("Too many concurrent ignored uploads", { status: 429, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "1", connection: "close" } });
        boundedDiscard = true;
      } else {
        discards.active++; discards.clients.set(key, count + 1);
        releaseDiscard = () => {
          discards.active--;
          const next = (discards.clients.get(key) ?? 1) - 1;
          if (next) discards.clients.set(key, next); else discards.clients.delete(key);
        };
      }
    }
    const lengthHeader = response.headers.get("content-length");
    const length = lengthHeader === null ? undefined : Number(lengthHeader);
    if (length !== undefined && (!/^\d+$/.test(lengthHeader!) || !Number.isSafeInteger(length))) throw new Error("Invalid response length");
    const headerEntries: Record<string, string | string[]> = {};
    for (const [name, value] of response.headers) if (name !== "set-cookie" && (name !== "transfer-encoding" || length === undefined)) headerEntries[name] = value;
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headerEntries["set-cookie"] = cookies;
    // A client waiting for Continue has not sent a body to drain.
    if (hasBody && !bodyEnded && (expectContinue || boundedDiscard)) headerEntries.connection = "close";
    outgoing.writeHead(response.status, headerEntries);
    const endResponse = async () => {
      if (hasBody && !bodyEnded && !expectContinue) {
        discarding = true;
        discardStartedAtBytes = received;
        const discarded = new Promise<void>((resolve) => { finishDiscard = () => { if (boundedDiscard) incoming.pause(); clearTimeout(discardTimer); resolve(); }; });
        if (boundedDiscard) discardTimer = setTimeout(() => finishDiscard?.(), releaseDiscard ? 250 : 0);
        else resetDiscardTimeout();
        incoming.resume();
        // Bun ends IncomingMessage with ServerResponse even on keepalive. Flush
        // final headers now, but retain the reader until all body bytes drain.
        outgoing.flushHeaders();
        await discarded;
      }
      if (!outgoing.destroyed && !outgoing.writableEnded) outgoing.end();
    };
    const bodyless = incoming.method === "HEAD" || response.status === 204 || response.status === 304 || !response.body;
    if (bodyless) {
      void response.body?.cancel().catch(() => {});
      await endResponse();
      return;
    }
    outgoing.flushHeaders();
    const reader = response.body!.getReader();
    responseReader = reader;
    let written = 0;
    while (!abort.signal.aborted && !outgoing.destroyed) {
      const { done, value } = await reader.read();
      if (done) {
        if (length !== undefined && written !== length) throw new Error("Incomplete response body");
        await endResponse();
        return;
      }
      written += value.byteLength;
      if (length !== undefined && written > length) throw new Error("Response exceeds declared length");
      if (!outgoing.write(value)) await waitForDrain(outgoing, abort.signal);
    }
  } catch (error) {
    cancelResponse(error);
    if (outgoing.headersSent) outgoing.destroy();
    else plain(outgoing, 500, "Internal server error");
  } finally {
    // Never await arbitrary producer cancellation: its hook may itself remain pending.
    if (responseReader) { try { responseReader.releaseLock(); } catch { /* a pending cancel owns the reader */ } }
  }
}

function waitForDrain(outgoing: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      outgoing.off("drain", onDrain);
      outgoing.off("error", onError);
      outgoing.off("close", onClose);
      signal.removeEventListener("abort", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => onError(new Error("Client disconnected"));
    outgoing.once("drain", onDrain);
    outgoing.once("error", onError);
    outgoing.once("close", onClose);
    signal.addEventListener("abort", onClose, { once: true });
    if (outgoing.destroyed || signal.aborted) onClose();
  });
}
