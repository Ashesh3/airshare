import { randomKey } from "./capability-keys";
import {
  channelReceiverCount,
  keyFor,
  noteProtection,
  origin,
  persist,
  refreshHost,
  shortDownloadUrl,
  shortUploadUrl,
  touch,
  unused,
} from "./channels";
import type { App, Channel, Receiver, TransferOptions, Upload } from "./context";
import {
  contentDisposition,
  fileDetails,
  headerFilename,
  sanitizeFilename,
  terminalFilename,
  UNNAMED_FILE,
} from "./filenames";
import { abandonUpload } from "./http-server";
import type { FileDetails } from "./metadata-store";
import { asError, attempt, headerSize, HttpError, json, streamHeaders, withRetryAfter } from "./responses";
import { fileFields, occurredAt, transferEvent } from "./station";
import { notify } from "./streams";
import { TransferHash } from "./transfer-hash";

function downloadHeaders(channel: Channel, file: FileDetails) {
  // The sender picks the content type, so a download must never run as a page of this origin or be embedded elsewhere.
  return {
    ...streamHeaders,
    "content-type": file.contentType,
    "content-disposition": contentDisposition(file.filename),
    "x-airshare-channel": keyFor(channel, "receiver"),
    "content-security-policy": "sandbox; default-src 'none'",
    "cross-origin-resource-policy": "same-origin",
    ...(file.contentLength !== undefined ? { "content-length": String(file.contentLength) } : {}),
  };
}
function releaseReceiver(app: App, receiver: Receiver) {
  receiver.cleanup();
  receiver.clientRelease();
  if (receiver.channel.waiting.has(receiver)) {
    attempt(() => noteProtection(app, receiver.channel));
    attempt(() => persist(app, receiver.channel));
  }
  receiver.channel.waiting.delete(receiver);
  receiver.upload?.receivers.delete(receiver);
  app.receiverCount--;
  wakeReceiver(app, receiver);
}
export function failReceiver(app: App, receiver: Receiver, error: Error, reason: string, status = 502) {
  if (receiver.closed) return;
  receiver.closed = true;
  if (!receiver.responded) {
    receiver.responded = true;
    receiver.respond(withRetryAfter(json({ error: error.message, reason }, status), error));
  }
  receiver.controller.error(error);
  releaseReceiver(app, receiver);
  transferEvent(app, receiver, { failed: { tag: receiver.transferTag, occurred_at: occurredAt(), reason } });
  const upload = receiver.upload;
  if (upload && (reason === "receiver_disconnected" || reason === "receiver_stalled")) {
    const left = {
      tag: upload.transferTag,
      occurred_at: occurredAt(),
      reason,
      bytes_received: receiver.bytesWritten,
      receiver_count: upload.receivers.size,
    };
    transferEvent(app, upload, { receiver_left: left });
  }
  if (upload && upload.receivers.size === 0 && upload.successful === 0 && !live(upload).aborted) {
    const stalled = reason === "receiver_stalled";
    upload.abort.abort(
      new HttpError(
        409,
        stalled ? "All receivers stopped reading" : "All receivers disconnected",
        stalled ? reason : "no_receivers",
      ),
    );
  }
  notify(app, receiver.channel);
}
function respondReceiver(receiver: Receiver, metadata: Readonly<FileDetails>) {
  if (!receiver.responded && !receiver.closed) {
    receiver.responded = true;
    receiver.respond(new Response(receiver.stream, { headers: downloadHeaders(receiver.channel, metadata) }));
  }
}
/**
 * A receiver whose network vanished while it waited looks alive until its socket buffers fill, and Bun can't
 * turn on TCP keepalive for node:http sockets. Until a receiver has taken 16 queues' worth (1 MiB by default)
 * it gets the shorter first-byte limit, so a dead one holds the transfer back for seconds instead of minutes.
 * A peer that stopped acknowledging never grows its send buffer far beyond one queue.
 */
function firstByteTimeout(app: App) {
  return Math.min(app.config.receiverFirstByteTimeout, app.config.receiverStallTimeout);
}
function stallLimit(app: App, receiver: Receiver) {
  return receiver.bytesWritten < 16 * app.config.streamHighWaterMark
    ? firstByteTimeout(app)
    : app.config.receiverStallTimeout;
}
/** One shared timer replaces a timer per backpressure wait, which ran thousands of times a second at line rate. */
function watchStalls(app: App) {
  if (app.stallWatchdog) return;
  app.stallWatchdog = setInterval(
    () => {
      const now = Date.now();
      for (const receiver of app.blockedReceivers) {
        if (now - receiver.blockedSince! < stallLimit(app, receiver)) continue;
        receiver.stall?.(new HttpError(408, "Receiver stopped reading the transfer", "receiver_stalled"));
      }
      if (app.blockedReceivers.size === 0) {
        clearInterval(app.stallWatchdog);
        app.stallWatchdog = undefined;
      }
    },
    Math.max(25, Math.min(1000, Math.floor(firstByteTimeout(app) / 4))),
  );
  app.stallWatchdog.unref();
}
function unblock(app: App, receiver: Receiver) {
  const wake = receiver.wake;
  receiver.wake = receiver.stall = receiver.blockedSince = undefined;
  app.blockedReceivers.delete(receiver);
  return wake;
}
function wakeReceiver(app: App, receiver: Receiver) {
  unblock(app, receiver)?.();
}
async function receiverReady(app: App, receiver: Receiver, drained = false) {
  while (!receiver.closed && (receiver.controller.desiredSize ?? 0) < (drained ? app.config.streamHighWaterMark : 1)) {
    await new Promise<void>((resolve, reject) => {
      receiver.wake = resolve;
      receiver.stall = (error) => {
        unblock(app, receiver);
        reject(error);
      };
      receiver.blockedSince = Date.now();
      app.blockedReceivers.add(receiver);
      watchStalls(app);
    });
  }
  if (receiver.closed) throw new Error("Receiver disconnected");
}
async function writeReceiver(app: App, receiver: Receiver, chunk: Uint8Array) {
  await receiverReady(app, receiver);
  if (receiver.closed) throw new Error("Receiver disconnected");
  receiver.controller.enqueue(chunk);
  receiver.bytesWritten += chunk.byteLength;
  if (receiver.upload && receiver.bytesWritten > receiver.upload.maxReceived)
    receiver.upload.maxReceived = receiver.bytesWritten;
}
export function download(app: App, request: Request, channel: Channel, options: TransferOptions) {
  if (request.method === "HEAD") return new Response(null, { headers: downloadHeaders(channel, channel.file) });
  if (request.signal.aborted) throw new HttpError(499, "Request cancelled");
  if (
    app.receiverCount >= app.config.maxReceivers ||
    channelReceiverCount(channel) >= app.config.maxReceiversPerChannel
  ) {
    throw new HttpError(429, "Receiver limit reached");
  }
  const clientRelease = app.admission.leaseClient(request, "receiver");
  if (!clientRelease) throw new HttpError(429, "Client receiver limit reached");
  // Before the receiver is registered, so a failed save (a full disk) leaves only the lease to undo.
  try {
    touch(app, channel);
  } catch (error) {
    clientRelease();
    throw error;
  }
  let respond!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    respond = resolve;
  });
  const receiver: Receiver = {
    ...options,
    channel,
    stream: undefined!,
    controller: undefined!,
    respond,
    responded: false,
    closed: false,
    bytesWritten: 0,
    clientRelease,
    cleanup: () => request.signal.removeEventListener("abort", onAbort),
  };
  const onAbort = () => failReceiver(app, receiver, new Error("Receiver disconnected"), "receiver_disconnected", 499);
  receiver.stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        receiver.controller = controller;
      },
      pull() {
        wakeReceiver(app, receiver);
      },
      cancel() {
        onAbort();
      },
    },
    { highWaterMark: app.config.streamHighWaterMark, size: (chunk) => chunk?.byteLength ?? 0 },
  );
  app.receiverCount++;
  channel.waiting.add(receiver);
  request.signal.addEventListener("abort", onAbort, { once: true });
  channel.wakeUploader?.();
  notify(app, channel);
  return response;
}
async function waitForReceivers(app: App, channel: Channel, upload: Upload) {
  while (channel.waiting.size === 0) {
    upload.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        upload.signal.removeEventListener("abort", abort);
        if (channel.wakeUploader === wake) channel.wakeUploader = undefined;
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(upload.signal.reason);
      };
      channel.wakeUploader = wake;
      upload.signal.addEventListener("abort", abort, { once: true });
      if (upload.signal.aborted) abort();
    });
  }
  upload.signal.throwIfAborted();
  upload.started = true;
  if (channel.usedAt === undefined) {
    channel.usedAt = Date.now();
    persist(app, channel);
  }
  for (const receiver of channel.waiting) {
    receiver.upload = upload;
    upload.receivers.add(receiver);
    transferEvent(app, receiver, {
      started: { tag: receiver.transferTag, occurred_at: occurredAt(), ...fileFields(upload.metadata) },
    });
  }
  channel.waiting.clear();
  notify(app, channel);
}
function uploadMetadata(request: Request, channel: Channel) {
  const pathname = new URL(request.url).pathname;
  const pathName = pathname.match(/\/upload\/(.+)$/)?.[1] ?? pathname.match(/^\/u\/[^/]+\/(.+)$/)?.[1];
  const urlName = pathName ? decodeURIComponent(pathName) : undefined;
  // A placeholder in the URL yields to a name header, but is still a name: a file can be called "airshare-download".
  const placeholder = urlName !== undefined && sanitizeFilename(urlName) === UNNAMED_FILE;
  const suppliedName = placeholder ? (headerFilename(request) ?? urlName) : (urlName ?? headerFilename(request));
  const filename = suppliedName !== undefined ? terminalFilename(suppliedName) : channel.file.filename;
  const explicitSize = headerSize(
    request.headers.get("x-airshare-file-size") ?? request.headers.get("x-station307-file-size"),
    "Advertised file size",
  );
  const requestSize = headerSize(request.headers.get("content-length"), "Content-Length");
  // The request's own length beats a size stored from an earlier file; the stored size only checks chunked bodies.
  const expected = explicitSize ?? requestSize ?? channel.file.contentLength;
  if (requestSize !== undefined && expected !== undefined && requestSize !== expected) {
    throw new HttpError(
      400,
      `Request body length ${requestSize} does not match advertised file size ${expected}`,
      "size_mismatch",
    );
  }
  const transportType = request.headers.get("content-type");
  // --post-file adds a form MIME type despite sending unwrapped file bytes.
  // Keep the advertised channel type for that Wget default; explicit API
  // metadata can still advertise application/x-www-form-urlencoded itself.
  const wgetDefault =
    /^Wget\//i.test(request.headers.get("user-agent") ?? "") &&
    /^application\/x-www-form-urlencoded(?:;|$)/i.test(transportType ?? "");
  const contentType = wgetDefault ? channel.file.contentType : (transportType ?? channel.file.contentType);
  return Object.freeze(
    fileDetails({ filename, contentType, ...(expected !== undefined ? { contentLength: expected } : {}) }),
  );
}
/** Before the whole body has arrived the uploader leaving ends the transfer; after it, only deletion or shutdown does. */
function live(upload: Upload) {
  return upload.complete ? upload.abort.signal : upload.signal;
}
async function multicast(app: App, upload: Upload, chunk: Uint8Array) {
  live(upload).throwIfAborted();
  if (upload.receivers.size === 0) throw new HttpError(409, "No receivers remain", "no_receivers");
  await Promise.all(
    [...upload.receivers].map(async (receiver) => {
      try {
        await writeReceiver(app, receiver, chunk);
        respondReceiver(receiver, upload.metadata);
      } catch (error) {
        failReceiver(
          app,
          receiver,
          asError(error),
          error instanceof HttpError ? error.reason : "receiver_disconnected",
        );
      }
    }),
  );
  live(upload).throwIfAborted();
}
function progress(app: App, channel: Channel, upload: Upload, force = false) {
  if (!force && Date.now() - upload.lastProgress < 200) return;
  upload.lastProgress = Date.now();
  const expected = upload.metadata.contentLength;
  const percent =
    expected === undefined
      ? undefined
      : expected === 0
        ? 100
        : Math.min(100, Math.round((upload.bytes / expected) * 10_000) / 100);
  const occurred_at = occurredAt();
  let slowest = upload.receivers.size ? Infinity : upload.maxReceived;
  for (const receiver of upload.receivers) slowest = Math.min(slowest, receiver.bytesWritten);
  transferEvent(app, upload, {
    progressed: {
      tag: upload.transferTag,
      occurred_at,
      progress: percent,
      bytes_sent: upload.bytes,
      bytes_received: slowest,
    },
  });
  for (const receiver of upload.receivers) {
    transferEvent(app, receiver, {
      progressed: { tag: receiver.transferTag, occurred_at, progress: percent, bytes_received: receiver.bytesWritten },
    });
  }
  notify(app, channel);
}
function transferCounts(upload: Upload) {
  return { bytes_sent: upload.bytes, bytes_received: upload.maxReceived, receiver_count: upload.successful };
}
async function pump(app: App, channel: Channel, upload: Upload) {
  const highWaterMark = app.config.streamHighWaterMark;
  const expected = upload.metadata.contentLength;
  let finalByte: Uint8Array | undefined;
  const started = {
    tag: upload.transferTag,
    occurred_at: occurredAt(),
    receiver_count: upload.receivers.size,
    ...fileFields(upload.metadata),
  };
  transferEvent(app, upload, { started });
  while (upload.reader) {
    upload.signal.throwIfAborted();
    const { done, value } = await upload.reader.read();
    upload.signal.throwIfAborted();
    if (done) break;
    if (!value?.byteLength) continue;
    if (expected !== undefined && upload.bytes + value.byteLength > expected) {
      throw new HttpError(400, "Upload exceeds its advertised file size", "size_mismatch");
    }
    upload.bytes += value.byteLength;
    const end = expected !== undefined && upload.bytes === expected ? value.byteLength - 1 : value.byteLength;
    // Withhold the final byte until EOF: Content-Length must not turn an
    // oversized chunked upload into an apparently successful truncated file.
    if (end < value.byteLength) finalByte = value.slice(-1);
    const hashed = upload.hasher?.update(value);
    for (let offset = 0; offset < end; offset += highWaterMark)
      await multicast(app, upload, value.subarray(offset, Math.min(end, offset + highWaterMark)));
    if (hashed) await hashed;
    progress(app, channel, upload);
  }
  upload.signal.throwIfAborted();
  if (expected !== undefined && upload.bytes !== expected)
    throw new HttpError(400, "Upload ended before its advertised file size", "size_mismatch");
  upload.complete = true;
  upload.hash = await upload.hasher?.digest();
  if (finalByte) await multicast(app, upload, finalByte);
  if (upload.receivers.size === 0) throw new HttpError(409, "No receivers remain", "no_receivers");
  progress(app, channel, upload, true);
  await Promise.all(
    [...upload.receivers].map(async (receiver) => {
      try {
        respondReceiver(receiver, upload.metadata);
        await receiverReady(app, receiver, true);
        live(upload).throwIfAborted();
        if (receiver.closed) return;
        receiver.controller.close();
        receiver.closed = true;
        upload.successful++;
        releaseReceiver(app, receiver);
        const succeeded = {
          tag: receiver.transferTag,
          occurred_at: occurredAt(),
          hash: upload.hash,
          bytes_received: receiver.bytesWritten,
        };
        transferEvent(app, receiver, { succeeded });
      } catch (error) {
        failReceiver(
          app,
          receiver,
          asError(error),
          error instanceof HttpError ? error.reason : "receiver_disconnected",
        );
      }
    }),
  );
  // A share deleted while a receiver was still draining cut that receiver, so the upload must not report success.
  live(upload).throwIfAborted();
  if (upload.successful === 0) throw new HttpError(409, "No receiver completed the transfer", "no_receivers");
  channel.completedTransfers += upload.successful;
  // The file has reached its receivers, so a failed save must not report the transfer as failed.
  attempt(() => touch(app, channel));
  attempt(() => persist(app, channel));
  transferEvent(app, upload, {
    succeeded: { tag: upload.transferTag, occurred_at: occurredAt(), hash: upload.hash, ...transferCounts(upload) },
  });
}
export async function handleUpload(app: App, request: Request, channel: Channel, options: TransferOptions) {
  const previous = channel.upload;
  if (previous?.started)
    throw new HttpError(409, "A transfer is in progress on this channel; retry when it finishes", "busy");
  if (request.signal.aborted) throw new HttpError(499, "Upload cancelled");
  const uploadId = request.headers.get("x-airshare-upload-id") ?? randomKey();
  if (!/^[\x21-\x7e]{1,128}$/.test(uploadId)) throw new HttpError(400, "Invalid upload identifier");
  const flag = (name: string) => ["1", "true"].includes(request.headers.get(name) ?? "");
  const stationNoRedirect = flag("x-station307-no-redirect") || flag("com.station307.no-redirect");
  const noRedirect = stationNoRedirect || flag("x-airshare-no-redirect");
  // Hashing costs relay throughput, so only Station clients (which expect it) and explicit requests pay for it.
  // Station-format tracker events report the hash; AirShare's own page never tracks its uploads that way.
  const stationTracked = options.trackerKey !== undefined && app.trackers.get(options.trackerKey)?.native === false;
  const hashed = app.config.transferHash && (stationNoRedirect || stationTracked || flag("x-airshare-hash"));
  const metadata = uploadMetadata(request, channel);
  if (!request.body && metadata.contentLength !== 0) throw new HttpError(400, "Upload body required");
  // Checked before replacing a waiting upload, so a refused request leaves that upload in place.
  const clientRelease = app.admission.leaseClient(request, "upload");
  if (!clientRelease) throw new HttpError(429, "Too many uploads from this client at once", "upload_limit", 1);
  // A sender that reconnects replaces its own half-open upload, which is still waiting for receivers.
  previous?.abort.abort(new HttpError(409, "A newer upload replaced this waiting upload", "replaced"));
  const abort = new AbortController();
  const upload: Upload = {
    ...options,
    metadata,
    abort,
    signal: AbortSignal.any([request.signal, abort.signal]),
    receivers: new Set(),
    started: false,
    bytes: 0,
    successful: 0,
    lastProgress: 0,
    reader: request.body?.getReader(),
    uploadId,
    hasher: hashed ? new TransferHash() : undefined,
    maxReceived: 0,
    complete: false,
  };
  const onAbort = () => {
    // Once the whole body is in, the uploader hanging up isn't a cancellation; deletion or shutdown still is.
    if (upload.complete && !abort.signal.aborted) {
      abort.signal.addEventListener("abort", onAbort, { once: true });
      return;
    }
    const error = asError(abort.signal.aborted ? abort.signal.reason : upload.signal.reason);
    void upload.reader?.cancel(error).catch(() => {});
    // A restart tells receivers to come back, the same answer receivers that weren't attached yet get.
    const stopping = error instanceof HttpError && error.reason === "stopping";
    for (const receiver of [...upload.receivers]) {
      failReceiver(app, receiver, error, stopping ? "stopping" : "upload_cancelled", stopping ? error.status : 410);
    }
  };
  upload.signal.addEventListener("abort", onAbort, { once: true });
  channel.upload = upload;
  channel.file = metadata;
  channel.lastError = undefined;
  try {
    // Inside the try, so a failed save (a full disk) still releases the client's upload slot.
    touch(app, channel);
    persist(app, channel);
    refreshHost(app, channel);
    notify(app, channel);
    await waitForReceivers(app, channel, upload);
    await pump(app, channel, upload);
    channel.lastUpload = { id: uploadId, reason: "completed", retryable: false };
  } catch (error) {
    const failure = asError(error);
    const reason = error instanceof HttpError ? error.reason : "upload_failed";
    const retryable =
      !channel.closed && !request.signal.aborted && (reason === "no_receivers" || reason === "receiver_stalled");
    if (reason !== "replaced") {
      channel.lastError = retryable ? undefined : failure.message;
      channel.lastUpload = { id: uploadId, reason, retryable, error: failure.message };
    }
    for (const receiver of [...upload.receivers])
      failReceiver(app, receiver, failure, reason, error instanceof HttpError ? error.status : 502);
    void upload.reader?.cancel(failure).catch(() => {});
    transferEvent(app, upload, { failed: { tag: upload.transferTag, occurred_at: occurredAt(), reason } });
    if (retryable && !noRedirect && request.headers.has("content-length"))
      return abandonUpload(replayUpload(app, request, channel, metadata));
    const status = channel.closed
      ? 410
      : error instanceof HttpError
        ? error.status
        : request.signal.aborted
          ? 499
          : 502;
    const body = {
      error: failure.message,
      reason,
      retryable,
      failed: { error: failure.message, reason, ...transferCounts(upload) },
    };
    return abandonUpload(withRetryAfter(json(body, status), error));
  } finally {
    clientRelease();
    upload.hasher?.cancel();
    upload.signal.removeEventListener("abort", onAbort);
    abort.signal.removeEventListener("abort", onAbort);
    upload.reader?.releaseLock();
    if (channel.upload === upload) {
      channel.upload = undefined;
      channel.wakeUploader = undefined;
    }
    attempt(() => noteProtection(app, channel));
    attempt(() => touch(app, channel));
    attempt(() => {
      if (unused(channel)) persist(app, channel);
    });
    attempt(() => refreshHost(app, channel));
    attempt(() => notify(app, channel));
  }
  if (noRedirect) return json({ succeeded: { hash: upload.hash, ...transferCounts(upload) } });
  // stdin/chunked bodies cannot be replayed. A regular file remains hosted by
  // asking curl/wget to resend the same file to the same sender capability.
  if (!request.headers.has("content-length"))
    return new Response("Transfer complete. This input stream is available once.\n", { headers: streamHeaders });
  return replayUpload(app, request, channel, metadata);
}
function replayUpload(app: App, request: Request, channel: Channel, metadata: Readonly<FileDetails>) {
  const name = encodeURIComponent(metadata.filename);
  const location = shortUploadUrl(origin(app, request), channel, name);
  // Only the first redirect introduces the share, so a hosting terminal's `| grep human` output stays short.
  const downloadUrl = shortDownloadUrl(origin(app, request), channel, name);
  const headers = {
    ...streamHeaders,
    location,
    "x-airshare-download-url": downloadUrl,
    "x-airshare-upload-url": location,
    "content-length": "0",
  };
  return new Response(null, { status: 307, headers });
}
