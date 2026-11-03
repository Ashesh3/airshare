import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config";
import { MetadataStore, type ChannelMetadata, type FileDetails } from "./metadata-store";
import { qrHeaders, qrSvg, qrTerminal } from "./qr";
import { abandonUpload, onRequestFinished, serveHttp } from "./http-server";
import { admitCreation, clientIdentity, leaseClient } from "./admission";

type Role = "owner" | "sender" | "receiver";
type Capability = { channel: Channel; role: Role };
type TransferOptions = { trackerKey?: string; transferTag?: string };
type Sse = { send: (event: string, data: unknown) => boolean; finish: () => void; response: Response };
type NativeSubscriber = { role: Role; origin: string; hosting: boolean; sse: Sse };
type Tracker = { id: string; sse: Sse; subscriptions: Map<string, Capability>; origin: string };
type Receiver = TransferOptions & {
  channel: Channel; stream: ReadableStream<Uint8Array>; controller: ReadableStreamDefaultController<Uint8Array>;
  respond: (response: Response) => void; responded: boolean; closed: boolean; bytesWritten: number;
  wake?: () => void; cleanup: () => void; clientRelease: () => void; upload?: Upload;
};
type Upload = TransferOptions & {
  metadata: Readonly<FileDetails>; abort: AbortController; signal: AbortSignal; receivers: Set<Receiver>;
  reader?: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock">; started: boolean; bytes: number; successful: number; lastProgress: number; uploadId: string;
};
type Channel = ChannelMetadata & {
  waiting: Set<Receiver>; subscribers: Set<NativeSubscriber>; trackers: Map<Tracker, Set<Role>>;
  upload?: Upload; wakeUploader?: () => void; closed: boolean; lastPersisted: number; lastError?: string; senderLeaseUntil: number;
  lastUpload?: { id: string; reason: string; retryable: boolean; error?: string };
  creating: boolean;
};
class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly reason = "transfer_failed", readonly retryAfter?: number) { super(message); }
}

const encoder = new TextEncoder();
const store = new MetadataStore(config.dataDir);
const channels = new Map<string, Channel>();
const capabilities = new Map<string, Capability>();
const trackers = new Map<string, Tracker>();
const clientChannelCounts = new Map<string, number>();
const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
let receiverCount = 0;
let subscriberCount = 0;
let stopping = false;
let storeClosed = false;
const commonHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff", "access-control-allow-origin": "*", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };
const streamHeaders = { ...commonHeaders, "x-accel-buffering": "no" };

function json(data: unknown, status = 200) {
  const body = JSON.stringify(data);
  return new Response(body, { status, headers: { ...commonHeaders, "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(body)) } });
}
function notFound() { return new Response("Not found", { status: 404, headers: commonHeaders }); }
function id() { return crypto.randomUUID().replaceAll("-", ""); }
function origin(request: Request) { return config.publicOrigin ?? new URL(request.url).origin; }
function keyFor(channel: Channel, role: Role) { return role === "owner" ? channel.id : role === "sender" ? channel.senderKey : channel.receiverKey; }
function stationKey(channel: Channel, role: Role) { return { [role === "owner" ? "channel" : role]: keyFor(channel, role) }; }
function senderOnline(channel: Channel) {
  return !!channel.upload || channel.senderLeaseUntil > Date.now() || [...channel.subscribers].some((item) => item.hosting) ||
    [...channel.trackers.values()].some((roles) => roles.has("sender") || roles.has("owner"));
}
function channelReceiverCount(channel: Channel) { return channel.waiting.size + (channel.upload?.receivers.size ?? 0); }
function channelPayload(channel: Channel, role: Role, base: string) {
  const key = keyFor(channel, role);
  const name = encodeURIComponent(channel.file.filename);
  return {
    id: key, role, file: channel.file,
    ...(role !== "receiver" ? { uploadUrl: `${base}/api/channels/${channel.senderKey}/upload/${name}` } : {}),
    downloadUrl: `${base}/download/${channel.receiverKey}/${name}`, humanUrl: `${base}/r/${channel.receiverKey}`,
    eventsUrl: `${base}/api/channels/${key}/events`, statusUrl: `${base}/api/channels/${key}`,
    ...(role === "owner" ? { deleteUrl: `${base}/api/channels/${channel.id}` } : {}),
    waitingReceivers: channel.waiting.size, activeReceivers: channel.upload?.receivers.size ?? 0,
    activeUpload: !!channel.upload, completedTransfers: channel.completedTransfers, senderOnline: senderOnline(channel),
    bytesTransferred: channel.upload?.bytes ?? 0, ...(channel.lastError ? { lastError: channel.lastError } : {}),
    ...(role !== "receiver" ? {
      activeUploadId: channel.upload?.uploadId,
      lastUploadId: channel.lastUpload?.id, lastUploadReason: channel.lastUpload?.reason,
      lastUploadRetryable: channel.lastUpload?.retryable, lastUploadError: channel.lastUpload?.error,
    } : {}),
  };
}
function stationDetails(channel: Channel, role: Role, base: string) {
  const name = encodeURIComponent(channel.file.filename);
  return {
    keys: {
      ...(role === "owner" ? { channel_key: channel.id } : {}),
      ...(role !== "receiver" ? { sender_key: channel.senderKey } : {}),
      ...(role !== "sender" ? { receiver_key: channel.receiverKey } : {}),
    },
    file_details: { filename: channel.file.filename, content_type: channel.file.contentType, content_length: channel.file.contentLength },
    urls: {
      ...(role !== "receiver" ? { sender_url: `${base}/api/v1/channel/sender/${channel.senderKey}/upload/${name}` } : {}),
      receiver_url: `${base}/api/v1/channel/receiver/${channel.receiverKey}/download/${name}`,
    },
    human_urls: {
      ...(role !== "receiver" ? { sender_url: `${base}/send/${channel.senderKey}` } : {}),
      receiver_url: `${base}/recv/${channel.receiverKey}`,
    },
  };
}

function register(metadata: ChannelMetadata): Channel {
  const channel: Channel = { ...metadata, waiting: new Set(), subscribers: new Set(), trackers: new Map(), closed: false, lastPersisted: metadata.lastTouched, senderLeaseUntil: 0, creating: false };
  channels.set(channel.id, channel);
  if (channel.clientQuotaId) clientChannelCounts.set(channel.clientQuotaId, (clientChannelCounts.get(channel.clientQuotaId) ?? 0) + 1);
  for (const role of ["owner", "sender", "receiver"] as const) capabilities.set(keyFor(channel, role), { channel, role });
  return channel;
}
for (const metadata of store.load(Date.now() - config.channelTtl, config.maxChannels)) register(metadata);
function persist(channel: Channel) { if (!channel.closed && !storeClosed) { store.save(channel); channel.lastPersisted = channel.lastTouched; } }
function touch(channel: Channel) {
  if (stopping) return;
  channel.lastTouched = Date.now();
  if (channel.lastTouched - channel.lastPersisted >= Math.min(30_000, config.channelTtl / 2, unused(channel) ? config.unusedChannelTtl / 2 : Infinity)) persist(channel);
}
function protectedChannel(channel: Channel) { return channel.creating || !!channel.upload || channel.waiting.size > 0 || senderOnline(channel); }
function unused(channel: Channel) { return channel.usedAt === undefined && channel.completedTransfers === 0; }
function noteProtection(channel: Channel) { channel.lastProtectedAt = Date.now(); touch(channel); }
function idleSince(channel: Channel) { return Math.max(channel.lastProtectedAt ?? channel.createdAt, channel.senderLeaseUntil); }
function expired(channel: Channel) {
  if (protectedChannel(channel)) { noteProtection(channel); return false; }
  return unused(channel) ? Date.now() - idleSince(channel) >= Math.min(config.unusedChannelTtl, config.channelTtl) : Date.now() - channel.lastTouched >= config.channelTtl;
}
function lookup(key: string, allowed?: Role[]): Capability | undefined {
  const capability = capabilities.get(key);
  if (!capability) return;
  if (expired(capability.channel)) { closeChannel(capability.channel, "expired"); return; }
  if (allowed && !allowed.includes(capability.role)) return;
  touch(capability.channel);
  return capability;
}
function cleanupExpired() { for (const channel of channels.values()) if (expired(channel)) closeChannel(channel, "expired"); }
const cleanupTimer = setInterval(cleanupExpired, config.cleanupInterval);
cleanupTimer.unref();
function createChannel(request: Request, file: FileDetails) {
  const retryAfter = admitCreation(request);
  if (retryAfter) throw new HttpError(429, "Channel creation rate exceeded", "creation_rate", retryAfter);
  cleanupExpired();
  const clientQuotaId = new Bun.CryptoHasher("sha256").update(`airshare-client-v1:${clientIdentity(request)}`).digest("hex");
  if (config.maxChannelsPerClient && (clientChannelCounts.get(clientQuotaId) ?? 0) >= config.maxChannelsPerClient) throw new HttpError(429, "Client channel quota reached; close unused shares or wait for expiry", "channel_quota", 60);
  if (channels.size >= config.maxChannels) {
    let oldest: Channel | undefined;
    for (const candidate of channels.values()) if (unused(candidate) && !protectedChannel(candidate) && (!oldest || idleSince(candidate) < idleSince(oldest))) oldest = candidate;
    if (oldest) closeChannel(oldest, "capacity");
  }
  if (channels.size >= config.maxChannels) throw new HttpError(503, "Channel capacity reached; retry after unused channels expire");
  const now = Date.now();
  const channel = register({ id: id(), senderKey: id(), receiverKey: id(), file, createdAt: now, lastTouched: now, completedTransfers: 0, clientQuotaId });
  persist(channel);
  return channel;
}
function sanitizeFilename(value?: string) {
  const name = (value ?? "airshare-download").toWellFormed().split(/[\\/]/).at(-1) ?? "";
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069"]/g, "_").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "airshare-download";
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`);
  return value as Record<string, unknown>;
}
function fileDetails(value: unknown, station = false): FileDetails {
  const file = record(value, "File metadata");
  const filename = file.filename;
  const contentType = file[station ? "content_type" : "contentType"];
  const contentLength = file[station ? "content_length" : "contentLength"];
  if (filename !== undefined && (typeof filename !== "string" || filename.length > 512 || encoder.encode(filename).length > 1024)) throw new HttpError(400, "filename must be a string of at most 512 characters / 1024 UTF-8 bytes");
  if (contentType !== undefined && (typeof contentType !== "string" || !/^[\x20-\x7e]{1,255}$/.test(contentType) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?: *;[\x20-\x7e]*)?$/.test(contentType))) throw new HttpError(400, "contentType must be a valid media type string");
  if (contentLength !== undefined && (typeof contentLength !== "number" || !Number.isSafeInteger(contentLength) || contentLength < 0)) throw new HttpError(400, "contentLength must be a nonnegative safe integer");
  return { filename: sanitizeFilename(filename as string | undefined), contentType: contentType as string | undefined ?? "application/octet-stream", ...(contentLength !== undefined ? { contentLength: contentLength as number } : {}) };
}
function headerSize(value: string | null, label: string): number | undefined {
  if (value === null) return;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HttpError(400, `${label} must be a nonnegative safe integer`, "size_mismatch");
  return Number(value);
}
async function readJson(request: Request) {
  const length = headerSize(request.headers.get("content-length"), "Content-Length");
  if (length !== undefined && length > config.maxMetadataBytes) throw new HttpError(413, "Metadata body is too large");
  if (!request.body) throw new HttpError(400, "Expected a JSON body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > config.maxMetadataBytes) { void reader.cancel().catch(() => {}); throw new HttpError(413, "Metadata body is too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new HttpError(400, "Expected valid JSON"); }
  } finally { reader.releaseLock(); }
}

function sse(request: Request, onClose: () => void, heartbeat?: () => void, heartbeatMs = 15_000): Sse {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stop = (error?: Error) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    request.signal.removeEventListener("abort", onAbort);
    subscriberCount--;
    try { if (error) controller.error(error); else controller.close(); }
    catch { /* The HTTP consumer may already have cancelled the stream. */ }
    finally { onClose(); }
  };
  const onAbort = () => stop(new Error("Subscriber disconnected"));
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { stop(); } }, { highWaterMark: config.streamHighWaterMark, size: (chunk) => chunk?.byteLength ?? 0 });
  const send = (event: string, data: unknown) => {
    if (closed) return false;
    const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if ((controller.desiredSize ?? 0) < chunk.byteLength) { stop(new Error("Subscriber is too slow")); return false; }
    controller.enqueue(chunk);
    return true;
  };
  const timer = setInterval(() => {
    if (heartbeat) heartbeat();
    else if (!closed) {
      const chunk = encoder.encode(": ping\n\n");
      if ((controller.desiredSize ?? 0) < chunk.byteLength) stop(new Error("Subscriber is too slow")); else controller.enqueue(chunk);
    }
  }, heartbeatMs);
  timer.unref();
  subscriberCount++;
  request.signal.addEventListener("abort", onAbort, { once: true });
  return { send, finish: () => stop(), response: new Response(stream, { headers: { ...streamHeaders, "content-type": "text/event-stream; charset=utf-8" } }) };
}
function transferEvent(options: TransferOptions, event: unknown) { if (options.trackerKey) trackers.get(options.trackerKey)?.sse.send("transfer_event", event); }
function stationStatus(channel: Channel, tracker: Tracker, role: Role) {
  tracker.sse.send("channel_event", { status: { key: stationKey(channel, role), receivers_available: channel.waiting.size > 0, senders_available: !channel.closed && senderOnline(channel) } });
}
function notify(channel: Channel) {
  if (channel.closed) return;
  if (protectedChannel(channel)) noteProtection(channel);
  for (const subscriber of channel.subscribers) subscriber.sse.send("status", channelPayload(channel, subscriber.role, subscriber.origin));
  for (const [tracker, roles] of channel.trackers) for (const role of roles) stationStatus(channel, tracker, role);
}
function channelSubscriberCount(channel: Channel) { return channel.subscribers.size + [...channel.trackers.values()].reduce((sum, roles) => sum + roles.size, 0); }
function nativeEvents(request: Request, capability: Capability) {
  const { channel, role } = capability;
  if (request.signal.aborted) throw new HttpError(499, "Request cancelled");
  if (subscriberCount >= config.maxSubscribers || channelSubscriberCount(channel) >= config.maxSubscribersPerChannel) throw new HttpError(429, "Subscriber limit reached");
  const clientRelease = leaseClient(request, "subscriber");
  if (!clientRelease) throw new HttpError(429, "Client subscriber limit reached");
  const subscriber: NativeSubscriber = { role, origin: origin(request), hosting: role !== "receiver" && new URL(request.url).searchParams.get("hosting") === "1", sse: undefined! };
  subscriber.sse = sse(request, () => {
    if (subscriber.hosting) { noteProtection(channel); persist(channel); }
    clientRelease(); channel.subscribers.delete(subscriber); queueMicrotask(() => notify(channel));
  });
  channel.subscribers.add(subscriber);
  touch(channel);
  notify(channel);
  return subscriber.sse.response;
}
function track(request: Request) {
  if (request.signal.aborted) throw new HttpError(499, "Request cancelled");
  if (subscriberCount >= config.maxSubscribers) throw new HttpError(429, "Subscriber limit reached");
  const clientRelease = leaseClient(request, "subscriber");
  if (!clientRelease) throw new HttpError(429, "Client subscriber limit reached");
  const tracker: Tracker = { id: id(), sse: undefined!, subscriptions: new Map(), origin: origin(request) };
  tracker.sse = sse(request, () => {
    clientRelease();
    trackers.delete(tracker.id);
    for (const { channel, role } of tracker.subscriptions.values()) {
      if (role !== "receiver") { noteProtection(channel); persist(channel); }
      channel.trackers.delete(tracker); queueMicrotask(() => notify(channel));
    }
    tracker.subscriptions.clear();
  }, () => tracker.sse.send("tracker_event", { ping: Date.now() }), 5000);
  trackers.set(tracker.id, tracker);
  tracker.sse.send("tracker_event", { initialized: { tracker_key: tracker.id } });
  return tracker.sse.response;
}
function subscribe(tracker: Tracker, capability: Capability, tag?: string) {
  const { channel, role } = capability;
  const key = keyFor(channel, role);
  if (!tracker.subscriptions.has(key)) {
    if (tracker.subscriptions.size >= config.maxTrackerChannels || channelSubscriberCount(channel) >= config.maxSubscribersPerChannel) throw new HttpError(429, "Subscription limit reached");
    tracker.subscriptions.set(key, capability);
    let roles = channel.trackers.get(tracker);
    if (!roles) channel.trackers.set(tracker, roles = new Set());
    roles.add(role);
  }
  tracker.sse.send("tracker_event", { subscribed: { ...(tag ? { tag } : {}), key: stationKey(channel, role), channel_details: stationDetails(channel, role, tracker.origin) } });
  notify(channel);
}

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(filename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
function downloadHeaders(channel: Channel, file: FileDetails) {
  return { ...streamHeaders, "content-type": file.contentType, "content-disposition": contentDisposition(file.filename), "x-airshare-channel": channel.receiverKey,
    ...(file.contentLength !== undefined ? { "content-length": String(file.contentLength) } : {}) };
}
function releaseReceiver(receiver: Receiver) {
  receiver.cleanup();
  receiver.clientRelease();
  if (receiver.channel.waiting.has(receiver)) { noteProtection(receiver.channel); persist(receiver.channel); }
  receiver.channel.waiting.delete(receiver);
  receiver.upload?.receivers.delete(receiver);
  receiverCount--;
  receiver.wake?.();
  receiver.wake = undefined;
}
function failReceiver(receiver: Receiver, error: Error, reason: string, status = 502) {
  if (receiver.closed) return;
  receiver.closed = true;
  if (!receiver.responded) { receiver.responded = true; receiver.respond(new Response(error.message, { status, headers: streamHeaders })); }
  receiver.controller.error(error);
  releaseReceiver(receiver);
  transferEvent(receiver, { failed: { tag: receiver.transferTag, reason } });
  const upload = receiver.upload;
  if (upload && upload.receivers.size === 0 && upload.successful === 0 && !upload.signal.aborted) upload.abort.abort(new HttpError(409, reason === "receiver_stalled" ? "All receivers stopped reading" : "All receivers disconnected", reason === "receiver_stalled" ? reason : "no_receivers"));
  notify(receiver.channel);
}
function respondReceiver(receiver: Receiver, metadata: Readonly<FileDetails>) {
  if (!receiver.responded && !receiver.closed) {
    receiver.responded = true;
    receiver.respond(new Response(receiver.stream, { headers: downloadHeaders(receiver.channel, metadata) }));
  }
}
async function receiverReady(receiver: Receiver, drained = false) {
  while (!receiver.closed && (receiver.controller.desiredSize ?? 0) < (drained ? config.streamHighWaterMark : 1)) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        if (receiver.wake === wake) receiver.wake = undefined;
        reject(new HttpError(408, "Receiver stopped reading the transfer", "receiver_stalled"));
      }, config.receiverStallTimeout);
      receiver.wake = wake;
    });
  }
  if (receiver.closed) throw new Error("Receiver disconnected");
}
async function writeReceiver(receiver: Receiver, chunk: Uint8Array) {
  await receiverReady(receiver);
  if (receiver.closed) throw new Error("Receiver disconnected");
  receiver.controller.enqueue(chunk);
  receiver.bytesWritten += chunk.byteLength;
}
function download(request: Request, channel: Channel, options: TransferOptions) {
  if (request.method === "HEAD") return new Response(null, { headers: downloadHeaders(channel, channel.file) });
  if (request.signal.aborted) throw new HttpError(499, "Request cancelled");
  if (receiverCount >= config.maxReceivers || channelReceiverCount(channel) >= config.maxReceiversPerChannel) throw new HttpError(429, "Receiver limit reached");
  const clientRelease = leaseClient(request, "receiver");
  if (!clientRelease) throw new HttpError(429, "Client receiver limit reached");
  let respond!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { respond = resolve; });
  const receiver: Receiver = { ...options, channel, stream: undefined!, controller: undefined!, respond, responded: false, closed: false, bytesWritten: 0, clientRelease, cleanup: () => request.signal.removeEventListener("abort", onAbort) };
  const onAbort = () => failReceiver(receiver, new Error("Receiver disconnected"), "receiver_disconnected", 499);
  receiver.stream = new ReadableStream<Uint8Array>({
    start(controller) { receiver.controller = controller; },
    pull() { receiver.wake?.(); receiver.wake = undefined; },
    cancel() { onAbort(); },
  }, { highWaterMark: config.streamHighWaterMark, size: (chunk) => chunk?.byteLength ?? 0 });
  receiverCount++;
  channel.waiting.add(receiver);
  request.signal.addEventListener("abort", onAbort, { once: true });
  touch(channel);
  channel.wakeUploader?.();
  notify(channel);
  return response;
}
async function waitForReceivers(channel: Channel, upload: Upload) {
  while (channel.waiting.size === 0) {
    upload.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { upload.signal.removeEventListener("abort", abort); if (channel.wakeUploader === wake) channel.wakeUploader = undefined; };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(upload.signal.reason); };
      channel.wakeUploader = wake;
      upload.signal.addEventListener("abort", abort, { once: true });
      if (upload.signal.aborted) abort();
    });
  }
  upload.signal.throwIfAborted();
  upload.started = true;
  if (channel.usedAt === undefined) { channel.usedAt = Date.now(); persist(channel); }
  for (const receiver of channel.waiting) {
    receiver.upload = upload;
    upload.receivers.add(receiver);
    transferEvent(receiver, { started: { tag: receiver.transferTag } });
  }
  channel.waiting.clear();
  notify(channel);
}
function uploadMetadata(request: Request, channel: Channel) {
  const name = new URL(request.url).pathname.match(/\/upload\/(.+)$/)?.[1];
  const explicitSize = headerSize(request.headers.get("x-airshare-file-size") ?? request.headers.get("x-station307-file-size"), "Advertised file size");
  const requestSize = headerSize(request.headers.get("content-length"), "Content-Length");
  const expected = explicitSize ?? channel.file.contentLength ?? requestSize;
  if (requestSize !== undefined && expected !== undefined && requestSize !== expected) throw new HttpError(400, `Request body length ${requestSize} does not match advertised file size ${expected}`, "size_mismatch");
  const transportType = request.headers.get("content-type");
  // --post-file adds a form MIME type despite sending unwrapped file bytes.
  // Keep the advertised channel type for that Wget default; explicit API
  // metadata can still advertise application/x-www-form-urlencoded itself.
  const wgetDefault = /^Wget\//i.test(request.headers.get("user-agent") ?? "") && /^application\/x-www-form-urlencoded(?:;|$)/i.test(transportType ?? "");
  return Object.freeze(fileDetails({ filename: name ? decodeURIComponent(name) : channel.file.filename, contentType: wgetDefault ? channel.file.contentType : transportType ?? channel.file.contentType, ...(expected !== undefined ? { contentLength: expected } : {}) }));
}
async function multicast(upload: Upload, chunk: Uint8Array) {
  upload.signal.throwIfAborted();
  if (upload.receivers.size === 0) throw new HttpError(409, "No receivers remain", "no_receivers");
  await Promise.all([...upload.receivers].map(async (receiver) => {
    try { await writeReceiver(receiver, chunk); respondReceiver(receiver, upload.metadata); }
    catch (error) { failReceiver(receiver, asError(error), error instanceof HttpError ? error.reason : "receiver_disconnected"); }
  }));
  upload.signal.throwIfAborted();
}
function progress(channel: Channel, upload: Upload, force = false) {
  if (!force && Date.now() - upload.lastProgress < 200) return;
  upload.lastProgress = Date.now();
  const expected = upload.metadata.contentLength;
  const percent = expected === undefined ? undefined : expected === 0 ? 100 : Math.min(100, Math.round(upload.bytes / expected * 100));
  transferEvent(upload, { progressed: { tag: upload.transferTag, bytes_sent: upload.bytes, progress: percent } });
  for (const receiver of upload.receivers) transferEvent(receiver, { progressed: { tag: receiver.transferTag, bytes_received: receiver.bytesWritten, progress: percent } });
  notify(channel);
}
async function pump(channel: Channel, upload: Upload) {
  const expected = upload.metadata.contentLength;
  let finalByte: Uint8Array | undefined;
  transferEvent(upload, { started: { tag: upload.transferTag, receiver_count: upload.receivers.size } });
  while (upload.reader) {
    upload.signal.throwIfAborted();
    const { done, value } = await upload.reader.read();
    upload.signal.throwIfAborted();
    if (done) break;
    if (!value?.byteLength) continue;
    if (expected !== undefined && upload.bytes + value.byteLength > expected) throw new HttpError(400, "Upload exceeds its advertised file size", "size_mismatch");
    upload.bytes += value.byteLength;
    const end = expected !== undefined && upload.bytes === expected ? value.byteLength - 1 : value.byteLength;
    // Withhold the final byte until EOF: Content-Length must not turn an
    // oversized chunked upload into an apparently successful truncated file.
    if (end < value.byteLength) finalByte = value.slice(-1);
    for (let offset = 0; offset < end; offset += config.streamHighWaterMark) await multicast(upload, value.subarray(offset, Math.min(end, offset + config.streamHighWaterMark)));
    progress(channel, upload);
  }
  upload.signal.throwIfAborted();
  if (expected !== undefined && upload.bytes !== expected) throw new HttpError(400, "Upload ended before its advertised file size", "size_mismatch");
  if (finalByte) await multicast(upload, finalByte);
  if (upload.receivers.size === 0) throw new HttpError(409, "No receivers remain", "no_receivers");
  progress(channel, upload, true);
  await Promise.all([...upload.receivers].map(async (receiver) => {
    try {
      respondReceiver(receiver, upload.metadata);
      await receiverReady(receiver, true);
      upload.signal.throwIfAborted();
      if (receiver.closed) return;
      receiver.controller.close();
      receiver.closed = true;
      upload.successful++;
      releaseReceiver(receiver);
      transferEvent(receiver, { succeeded: { tag: receiver.transferTag, bytes_received: receiver.bytesWritten } });
    } catch (error) { failReceiver(receiver, asError(error), error instanceof HttpError ? error.reason : "receiver_disconnected"); }
  }));
  if (upload.successful === 0) throw new HttpError(409, "No receiver completed the transfer", "no_receivers");
  channel.completedTransfers += upload.successful;
  touch(channel);
  persist(channel);
  transferEvent(upload, { succeeded: { tag: upload.transferTag, bytes_sent: upload.bytes } });
}
function asError(error: unknown) { return error instanceof Error ? error : new Error(String(error)); }
async function handleUpload(request: Request, channel: Channel, options: TransferOptions, station: boolean) {
  if (channel.upload) throw new HttpError(409, "Channel is busy");
  if (request.signal.aborted) throw new HttpError(499, "Upload cancelled");
  const uploadId = request.headers.get("x-airshare-upload-id") ?? id();
  if (!/^[\x21-\x7e]{1,128}$/.test(uploadId)) throw new HttpError(400, "Invalid upload identifier");
  const noRedirect = ["x-airshare-no-redirect", "x-station307-no-redirect", "com.station307.no-redirect"].some((name) => ["1", "true"].includes(request.headers.get(name) ?? ""));
  const metadata = uploadMetadata(request, channel);
  if (!request.body && metadata.contentLength !== 0) throw new HttpError(400, "Upload body required");
  const abort = new AbortController();
  const upload: Upload = { ...options, metadata, abort, signal: AbortSignal.any([request.signal, abort.signal]), receivers: new Set(), started: false, bytes: 0, successful: 0, lastProgress: 0, reader: request.body?.getReader(), uploadId };
  const onAbort = () => {
    const error = asError(upload.signal.reason);
    void upload.reader?.cancel(error).catch(() => {});
    for (const receiver of [...upload.receivers]) failReceiver(receiver, error, "upload_cancelled", 410);
  };
  upload.signal.addEventListener("abort", onAbort, { once: true });
  channel.upload = upload;
  channel.file = metadata;
  channel.lastError = undefined;
  touch(channel);
  persist(channel);
  notify(channel);
  try {
    await waitForReceivers(channel, upload);
    await pump(channel, upload);
    channel.lastUpload = { id: uploadId, reason: "completed", retryable: false };
  } catch (error) {
    const failure = asError(error);
    const reason = error instanceof HttpError ? error.reason : "upload_failed";
    const retryable = !channel.closed && !request.signal.aborted && (reason === "no_receivers" || reason === "receiver_stalled");
    channel.lastError = retryable ? undefined : failure.message;
    channel.lastUpload = { id: uploadId, reason, retryable, error: failure.message };
    for (const receiver of [...upload.receivers]) failReceiver(receiver, failure, reason, error instanceof HttpError ? error.status : 502);
    void upload.reader?.cancel(failure).catch(() => {});
    transferEvent(upload, { failed: { tag: upload.transferTag, reason } });
    if (retryable && !noRedirect && request.headers.has("content-length")) return abandonUpload(replayUpload(request, channel, metadata, station));
    const status = channel.closed ? 410 : error instanceof HttpError ? error.status : request.signal.aborted ? 499 : 502;
    return abandonUpload(json({ error: failure.message, reason, retryable }, status));
  } finally {
    upload.signal.removeEventListener("abort", onAbort);
    upload.reader?.releaseLock();
    noteProtection(channel);
    channel.upload = undefined;
    channel.wakeUploader = undefined;
    touch(channel);
    if (unused(channel)) persist(channel);
    notify(channel);
  }
  if (noRedirect) return new Response(null, { status: station ? 200 : 204, headers: streamHeaders });
  // stdin/chunked bodies cannot be replayed. A regular file remains hosted by
  // asking curl/wget to resend the same file to the same sender capability.
  if (!request.headers.has("content-length")) return new Response("Transfer complete. This input stream is available once.\n", { headers: streamHeaders });
  return replayUpload(request, channel, metadata, station);
}
function replayUpload(request: Request, channel: Channel, metadata: Readonly<FileDetails>, station: boolean) {
  const name = encodeURIComponent(metadata.filename);
  const location = station ? `${origin(request)}/api/v1/channel/sender/${channel.senderKey}/upload/${name}` : `${origin(request)}/api/channels/${channel.senderKey}/upload/${name}`;
  return new Response(null, { status: 307, headers: { ...streamHeaders, ...cliHeaders(request, channel, false), location, "content-length": "0" } });
}
function closeChannel(channel: Channel, reason: string) {
  if (channel.closed) return;
  channel.closed = true;
  channel.upload?.abort.abort(new HttpError(410, "Channel closed", reason));
  for (const receiver of [...channel.waiting]) failReceiver(receiver, new Error("Channel closed"), reason, 410);
  for (const subscriber of [...channel.subscribers]) { subscriber.sse.send("closed", { reason }); subscriber.sse.finish(); }
  for (const [tracker, roles] of channel.trackers) for (const role of roles) { stationStatus(channel, tracker, role); tracker.subscriptions.delete(keyFor(channel, role)); }
  channel.trackers.clear();
  channels.delete(channel.id);
  if (channel.clientQuotaId) {
    const remaining = (clientChannelCounts.get(channel.clientQuotaId) ?? 1) - 1;
    if (remaining) clientChannelCounts.set(channel.clientQuotaId, remaining); else clientChannelCounts.delete(channel.clientQuotaId);
  }
  for (const role of ["owner", "sender", "receiver"] as const) capabilities.delete(keyFor(channel, role));
  store.delete(channel.id);
}

function transferOptions(request: Request): TransferOptions {
  const query = new URL(request.url).searchParams;
  const trackerKey = request.headers.get("com.station307.tracker") ?? query.get("com.station307.tracker") ?? query.get("tracker");
  const transferTag = request.headers.get("com.station307.tag") ?? query.get("com.station307.tag") ?? query.get("tag");
  for (const value of [trackerKey, transferTag]) if (value !== null && (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))) throw new HttpError(400, "Invalid transfer tracking value");
  return { trackerKey: trackerKey ?? undefined, transferTag: transferTag ?? undefined };
}
function cliHeaders(request: Request, channel: Channel, receiving: boolean) {
  const payload = channelPayload(channel, "owner", origin(request));
  const senderHuman = `${origin(request)}/send/${channel.senderKey}`;
  const human = receiving ? senderHuman : payload.humanUrl;
  const transfer = receiving ? payload.uploadUrl! : payload.downloadUrl;
  return {
    "x-airshare-human-url": human, "x-airshare-human-upload-url": senderHuman,
    "x-airshare-upload-url": payload.uploadUrl!, "x-airshare-download-url": payload.downloadUrl,
    "x-airshare-qr-url": `${origin(request)}/api/qr?url=${encodeURIComponent(human)}`,
    "com.station307.human.web.url": human, "com.station307.human.transfer.url": transfer,
    "com.station307.transfer.url": transfer, "com.station307.url": transfer, "com.station307.located-at": transfer,
  };
}
async function cliEntry(request: Request, pathname: string, receiving: boolean) {
  const prepare = new URL(request.url).searchParams.get("prepare") === "1";
  const requestLength = headerSize(request.headers.get("content-length"), "Content-Length");
  if (prepare && (request.method !== "POST" || request.headers.has("transfer-encoding") || requestLength !== undefined && requestLength !== 0)) throw new HttpError(400, "Prepare a channel using POST with no file body");
  if (!receiving && !prepare && requestLength === undefined) throw new HttpError(411, `Non-rewindable stdin must use a prepared sender URL. First run: curl -fsS -X POST '${origin(request)}${pathname}?prepare=1'`, "prepare_required");
  const name = pathname.replace(/^\/xfr\/?/, "").split("/").filter(Boolean).at(-1);
  const filename = request.headers.get("x-airshare-filename") ?? request.headers.get("x-station307-filename") ?? (name ? decodeURIComponent(name) : undefined);
  const transportType = request.headers.get("content-type");
  const defaultWgetType = /^Wget\//i.test(request.headers.get("user-agent") ?? "") && /^application\/x-www-form-urlencoded(?:;|$)/i.test(transportType ?? "");
  const file = fileDetails({ filename, contentType: defaultWgetType ? undefined : transportType ?? undefined, contentLength: receiving || prepare ? undefined : requestLength });
  const channel = createChannel(request, file);
  if (!receiving && !prepare) {
    channel.creating = true;
    onRequestFinished(request, () => { noteProtection(channel); channel.creating = false; persist(channel); notify(channel); });
  }
  const headers = cliHeaders(request, channel, receiving);
  const human = headers["x-airshare-human-url"];
  if (prepare) {
    const body = `${headers["x-airshare-upload-url"]}\n`;
    return new Response(body, { status: 201, headers: { ...streamHeaders, ...headers, ...await qrHeaders(human), "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(body)) } });
  }
  // Reply before reading the initial body so curl can follow the redirect
  // without consuming non-rewindable stdin (Expect: 100-continue).
  return new Response(null, {
    status: 307, headers: { ...streamHeaders, ...headers, ...await qrHeaders(human), "content-length": "0", connection: "close", location: receiving ? headers["x-airshare-download-url"] : headers["x-airshare-upload-url"] },
  });
}
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function pageHeader(active = "") {
  return `<header class="site-header"><div class="container header-inner"><nav class="nav-pills" aria-label="Primary">${[["Home", "/"], ["Recipes", "/recipes"], ["About", "/about"]].map(([label, href]) => `<a href="${href}"${label === active ? ' class="active" aria-current="page"' : ""}>${label}</a>`).join("")}</nav></div></header>`;
}
function pageFooter() {
  return `<footer class="footer"><div class="container"><p>© ${new Date().getUTCFullYear()} AirShare | <a href="/privacy">privacy</a> | <a href="/license">license</a></p></div></footer>`;
}
function pageHead(title: string) {
  return `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} - AirShare</title><link rel="preload" href="/fonts/lato-400.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/fonts/kanit-700.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/styles.css"></head>`;
}
function renderPage(request: Request, channel: Channel, role: "sender" | "receiver") {
  const payload = channelPayload(channel, role, origin(request));
  const sender = role === "sender";
  const file = escapeHtml(channel.file.filename);
  const data = JSON.stringify(payload).replace(/</g, "\\u003c");
  const markup = sender ? `
    <div class="sender-content"><div class="info-column"><form id="send-form" class="sender-form">
      <div id="send-drop-zone" class="form-field"><label for="send-file">File to send</label><input id="send-file" type="file" required></div>
      <div class="form-submit"><button id="send-button" type="submit" class="primary">Send</button></div>
      <div class="visually-hidden"><span id="file-name">No file selected</span><span id="file-size"></span><a id="share-link" tabindex="-1" href="${escapeHtml(payload.humanUrl)}">Receiver link</a></div>
      <progress id="transfer-progress" max="100" value="0" hidden aria-label="Upload progress"></progress>
      <div class="hosting-actions"><button id="retry-transfer" type="button" hidden>Retry transfer</button><button id="stop-hosting" type="button" hidden>Stop hosting</button></div>
      <p id="status" class="transfer-status" role="status" aria-live="polite">Choose a file to send.</p>
    </form></div></div>` : `
    <div class="receiver-alert">Continue to download <i id="file-name">${file}</i></div>
    <span id="file-size" class="visually-hidden"></span>
    <a id="download" class="primary" href="${escapeHtml(payload.downloadUrl)}">Download</a>
    <p id="status" class="transfer-status" role="status" aria-live="polite">Waiting for you to start the download.</p>`;
  return new Response(`<!doctype html><html lang="en">${pageHead(sender ? "Send a file" : file)}<body>
    ${pageHeader()}
    <main><section class="jumbotron compact-jumbotron"><div class="container"><h1>AirShare</h1><p>${sender ? "Share a requested file" : "Someone shares a file with you"}</p></div></section><section class="container transfer-page">${markup}</section></main>
    ${pageFooter()}
    <script>window.STATION_CHANNEL=${data};</script><script src="/transfer.js" defer></script><script src="/${sender ? "sender" : "receiver"}.js" defer></script></body></html>`, { headers: { ...commonHeaders, "content-type": "text/html; charset=utf-8" } });
}
function renderInfoPage(request: Request, name: string) {
  const base = escapeHtml(origin(request));
  const pages: Record<string, { title: string; body: string }> = {
    about: { title: "About", body: `<p>AirShare is an independent, open-source live file relay for browsers and terminals.</p><p>Choose a file, share its link, and keep the sender connected while the recipient downloads. Data streams through your server without saving file contents to disk.</p><h4>Self-hosted file transfers</h4><p>Run the relay near your devices and use HTTPS for Internet transfers. The sender's upload, the relay's connection, and the recipient's download determine transfer speed.</p><p>Source code and setup instructions are available on <a href="https://github.com/Ashesh3/airshare" target="_blank" rel="noopener noreferrer">GitHub</a>. AirShare is not affiliated with Station307.</p>` },
    recipes: { title: "Recipes", body: `<h3>Pipes &amp; cURL</h3><p>Pipes cannot be replayed. Prepare the channel before sending a stream, then share the receiver URL printed in its headers.</p><h4>Sending a folder</h4><pre><code>UPLOAD_URL=$(curl -fsS -X POST -D /dev/stderr "${base}/xfr/folder.tar.gz?prepare=1")\ntar -czf - ./folder | curl -fS -T - "$UPLOAD_URL"</code></pre><h4>Sending encrypted output</h4><pre><code>UPLOAD_URL=$(curl -fsS -X POST -D /dev/stderr "${base}/xfr/payload.gpg?prepare=1")\ngpg --encrypt -o - --recipient recipient@example.com ./file | curl -fS -T - "$UPLOAD_URL"</code></pre><h4>Sending a process dump</h4><pre><code>UPLOAD_URL=$(curl -fsS -X POST -D /dev/stderr "${base}/xfr/stack.txt?prepare=1")\njstack &lt;process-id&gt; | curl -fS -T - "$UPLOAD_URL"</code></pre><p>Use a POSIX shell for these examples. For binary native pipes on Windows, use PowerShell 7.4+ or cmd.exe. A stream is available once; regular files can stay hosted for repeated downloads.</p>` },
    privacy: { title: "Privacy", body: `<p>AirShare relays file contents live and does not save them on the server. The relay can observe the contents; transport encryption is not end-to-end encryption.</p><p>Channel metadata is saved in SQLite, including filenames, sizes, capability tokens, timestamps, counters, and an IP-derived quota identifier. Keep the metadata volume and sender/owner links private.</p><p>Hosting ends when the sender disconnects. Links may remain until their configured expiry so a returning sender can resume hosting. Your instance's operator controls its configuration and any proxy logging.</p>` },
    license: { title: "License", body: `<p>AirShare source code is available under the MIT license. See the <a href="https://github.com/Ashesh3/airshare/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">full license</a> in the project.</p><p>The bundled Lato and Kanit fonts use the SIL Open Font License 1.1. Their copyright and license notices are retained in <a href="/fonts/Lato-OFL.txt">Lato's license</a> and <a href="/fonts/Kanit-OFL.txt">Kanit's license</a>.</p>` },
  };
  const page = pages[name];
  if (!page) return notFound();
  return new Response(`<!doctype html><html lang="en">${pageHead(page.title)}<body>${pageHeader(page.title)}<main class="container info-page"><h1>${page.title}</h1>${page.body}</main>${pageFooter()}</body></html>`, { headers: { ...commonHeaders, "content-type": "text/html; charset=utf-8" } });
}
async function serveStatic(pathname: string, head: boolean) {
  const decoded = decodeURIComponent(pathname);
  if (/[\\\u0000:]/.test(decoded) || decoded.startsWith("//") || decoded.split("/").includes("..")) return notFound();
  const path = resolve(publicRoot, `.${decoded === "/" ? "/index.html" : decoded}`);
  const inside = (target: string) => { const rel = relative(publicRoot, target); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  if (!inside(path)) return notFound();
  try {
    if (!inside(await realpath(path)) || !(await stat(path)).isFile()) return notFound();
    const file = Bun.file(path);
    return new Response(head ? null : file, { headers: { ...commonHeaders, "content-type": file.type || "application/octet-stream", "content-length": String(file.size) } });
  } catch { return notFound(); }
}
async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  decodeURIComponent(path);
  const read = request.method === "GET" || request.method === "HEAD";
  const write = request.method === "POST" || request.method === "PUT";
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...commonHeaders, "access-control-allow-methods": "GET,HEAD,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type,x-airshare-no-redirect,x-airshare-file-size,x-airshare-filename,x-airshare-sender-presence,x-airshare-upload-id,x-station307-no-redirect,x-station307-file-size,x-station307-filename,com.station307.tracker,com.station307.tag,com.station307.no-redirect" } });
  if (read && path === "/healthz") return json({ status: "ok" });
  if (read && path === "/api/qr") {
    const input = url.searchParams.get("url");
    if (!input || input.length > 2048) throw new HttpError(400, "A same-origin share URL of at most 2048 characters is required");
    let target: URL;
    try { target = new URL(input); } catch { throw new HttpError(400, "Invalid QR URL"); }
    if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.origin !== origin(request)) throw new HttpError(400, "QR URLs must use this server's public origin");
    const terminal = url.searchParams.get("format") === "terminal";
    return new Response(request.method === "HEAD" ? null : terminal ? await qrTerminal(target.href) : await qrSvg(target.href), { headers: { ...commonHeaders, "content-type": terminal ? "text/plain; charset=utf-8" : "image/svg+xml; charset=utf-8" } });
  }
  if (request.method === "POST" && (path === "/api/channels" || path === "/api/v1/channel")) {
    const body = record(await readJson(request), "Channel request");
    const station = path === "/api/v1/channel";
    const file = fileDetails(station ? body.file_details === undefined ? {} : body.file_details : body, station);
    let tracking: { tracker: Tracker; tag?: string; role: Role } | undefined;
    if (station && body.tracker !== undefined) {
      const details = record(body.tracker, "tracker");
      if (typeof details.tracker_key !== "string" || (details.tag !== undefined && (typeof details.tag !== "string" || details.tag.length > 256))) throw new HttpError(400, "Invalid tracker metadata");
      const perspective = details.perspective ?? "channel";
      if (perspective !== "channel" && perspective !== "sender" && perspective !== "receiver") throw new HttpError(400, "Invalid tracker perspective");
      const tracker = trackers.get(details.tracker_key);
      if (!tracker) throw new HttpError(404, "Tracker not found");
      if (tracker.subscriptions.size >= config.maxTrackerChannels) throw new HttpError(429, "Subscription limit reached");
      tracking = { tracker, tag: details.tag as string | undefined, role: perspective === "channel" ? "owner" : perspective };
    }
    const channel = createChannel(request, file);
    if (tracking) subscribe(tracking.tracker, { channel, role: tracking.role }, tracking.tag);
    return station ? json(stationDetails(channel, "owner", origin(request))) : json(channelPayload(channel, "owner", origin(request)), 201);
  }
  if (request.method === "GET" && path === "/api/v1/track") return track(request);
  const subscription = path.match(/^\/api\/v1\/channel\/(?:(sender|receiver)\/)?([^/]+)\/subscribe\/([^/]+)$/);
  if (request.method === "POST" && subscription) {
    const role = (subscription[1] ?? "owner") as Role;
    const capability = lookup(decodeURIComponent(subscription[2]!), [role]);
    if (!capability) return notFound();
    const tracker = trackers.get(decodeURIComponent(subscription[3]!));
    if (!tracker) return notFound();
    subscribe(tracker, capability);
    return new Response(null, { status: 204, headers: commonHeaders });
  }
  const station = path.match(/^\/api\/v1\/channel\/(sender|receiver)\/([^/]+)(?:\/(upload|download)(?:\/.*)?)?$/);
  if (station) {
    const role = station[1] as "sender" | "receiver";
    const capability = lookup(decodeURIComponent(station[2]!), [role]);
    if (!capability) return notFound();
    if (read && !station[3]) return json(stationDetails(capability.channel, role, origin(request)));
    if (write && role === "sender" && station[3] === "upload") return handleUpload(request, capability.channel, transferOptions(request), true);
    if (read && role === "receiver" && station[3] === "download") return download(request, capability.channel, transferOptions(request));
    return notFound();
  }
  const native = path.match(/^\/api\/channels\/([^/]+)(?:\/(events|upload)(?:\/(.*))?)?$/);
  if (native) {
    const capability = lookup(decodeURIComponent(native[1]!));
    if (!capability) return notFound();
    const { channel, role } = capability;
    if (read && !native[2]) {
      if (role !== "receiver") {
        const presence = request.headers.get("x-airshare-sender-presence");
        if (presence === "1") { channel.senderLeaseUntil = Date.now() + 10_000; noteProtection(channel); }
        else if (presence === "0") { if (channel.senderLeaseUntil > Date.now()) noteProtection(channel); channel.senderLeaseUntil = 0; persist(channel); }
      }
      return json(channelPayload(channel, role, origin(request)));
    }
    if (request.method === "GET" && native[2] === "events" && native[3] === undefined) return nativeEvents(request, capability);
    if (request.method === "DELETE" && !native[2] && role === "owner") { closeChannel(channel, "deleted"); return new Response(null, { status: 204, headers: commonHeaders }); }
    if (write && native[2] === "upload" && role !== "receiver") return handleUpload(request, channel, transferOptions(request), false);
    return notFound();
  }
  const downloading = path.match(/^\/download\/([^/]+)(?:\/.*)?$/);
  if (read && downloading) {
    const capability = lookup(decodeURIComponent(downloading[1]!), ["receiver"]);
    return capability ? download(request, capability.channel, transferOptions(request)) : notFound();
  }
  const page = path.match(/^\/(r|recv|s|send)\/([^/]+)$/);
  if (read && page) {
    const role = page[1] === "r" || page[1] === "recv" ? "receiver" : "sender";
    const capability = lookup(decodeURIComponent(page[2]!), [role]);
    return capability ? renderPage(request, capability.channel, role) : notFound();
  }
  if (read && /^\/(recipes|about|privacy|license)$/.test(path)) return renderInfoPage(request, path.slice(1));
  const cli = /^(curl|Wget)\//i.test(request.headers.get("user-agent") ?? "");
  if ((path === "/xfr" || path.startsWith("/xfr/") || path === "/" && cli) && (read || write)) return cliEntry(request, path, read);
  const generic = !/^\/(api|download|r|recv|s|send)(\/|$)/.test(path);
  if (generic && write) return cliEntry(request, path, false);
  if (read) {
    const asset = await serveStatic(path, request.method === "HEAD");
    if (asset.status !== 404 || !generic || !cli || path === "/") return asset;
    const decoded = decodeURIComponent(path);
    if (/[\\\u0000:]/.test(decoded) || decoded.startsWith("//") || decoded.split("/").includes("..")) return notFound();
    return cliEntry(request, path, true);
  }
  return notFound();
}
// Bun's native HTTP writer drops Content-Length for live response streams.
// The node:http adapter retains framing while keeping bounded Web streams.
const server = await serveHttp({
  hostname: config.hostname, port: config.port, maxRequestBodySize: config.maxRequestBodySize,
  clientKey: clientIdentity, maxDiscards: config.maxDiscards, maxDiscardsPerClient: config.maxDiscardsPerClient,
  async fetch(request) {
    try { return await route(request); }
    catch (error) {
      if (error instanceof URIError) return json({ error: "Malformed URL encoding" }, 400);
      if (error instanceof HttpError) {
        const response = json({ error: error.message, reason: error.reason, retryable: false }, error.status);
        if (error.retryAfter) response.headers.set("retry-after", String(error.retryAfter));
        return response;
      }
      if (request.signal.aborted) return json({ error: "Request cancelled" }, 499);
      console.error("Request failed", asError(error).message);
      return json({ error: "Internal server error" }, 500);
    }
  },
  error() { return json({ error: "Internal server error" }, 500); },
});
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(cleanupTimer);
  for (const channel of channels.values()) { if (protectedChannel(channel)) noteProtection(channel); persist(channel); channel.upload?.abort.abort(new Error("Server stopping")); }
  for (const tracker of trackers.values()) tracker.sse.finish();
  storeClosed = true;
  store.close();
  void server.stop(true);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log(`AirShare listening on http://${config.hostname}:${server.port}`);
