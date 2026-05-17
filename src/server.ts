const PORT = Number(Bun.env.PORT ?? 3070);
const HOST = Bun.env.HOST ?? "0.0.0.0";
const PUBLIC_DIR = new URL("../public/", import.meta.url);

const STATIC_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const CLOUDFLARE_EMAIL_DECODE_JS = `(() => {
  function decode(value) {
    let email = "";
    const key = parseInt(value.slice(0, 2), 16);
    for (let index = 2; index < value.length; index += 2) {
      email += String.fromCharCode(parseInt(value.slice(index, index + 2), 16) ^ key);
    }
    try {
      return decodeURIComponent(escape(email));
    } catch {
      return email;
    }
  }

  for (const element of document.querySelectorAll(".__cf_email__")) {
    const encoded = element.getAttribute("data-cfemail");
    if (encoded) element.textContent = decode(encoded);
  }

  for (const link of document.querySelectorAll('a[href^="/cdn-cgi/l/email-protection#"]')) {
    const encoded = link.getAttribute("href")?.split("#")[1];
    if (encoded) link.setAttribute("href", "mailto:" + decode(encoded));
  }
})();`;

type FileDetails = {
  filename: string;
  contentType: string;
  contentLength?: number;
};

type Receiver = {
  id: string;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  closed: boolean;
  bytesWritten: number;
  trackerKey?: string;
  transferTag?: string;
};

type Subscriber = {
  id: string;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
};

type TrackerSubscriber = Subscriber & {
  trackerKey: string;
  channelKeys: Set<string>;
};

type Channel = {
  id: string;
  file: FileDetails;
  receivers: Receiver[];
  subscribers: Subscriber[];
  waitingResolvers: Array<() => void>;
  activeUpload: boolean;
  createdAt: number;
  completedTransfers: number;
  senderKey: string;
  receiverKey: string;
  channelKey: string;
};

type StationKey = { channel?: string; sender?: string; receiver?: string };

const channels = new Map<string, Channel>();
const channelsByStationKey = new Map<string, Channel>();
const trackerSubscribers = new Map<string, TrackerSubscriber>();
const encoder = new TextEncoder();

function makeId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("");
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...init.headers,
    },
  });
}

function notFound() {
  return new Response("Not found", { status: 404 });
}

function sanitizeFilename(value: string | undefined) {
  const name = (value || "airshare-download").split(/[\\/]/).pop() || "airshare-download";
  return name.replace(/[\r\n\0"]/g, "_").trim() || "airshare-download";
}

function contentDisposition(filename: string) {
  const safe = sanitizeFilename(filename);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeRFC5987ValueChars(safe)}`;
}

function encodeRFC5987ValueChars(value: string) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%(7C|60|5E)/g, (_, hex) => `%${hex}`);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

function fileFromPath(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  const last = parts.at(-1);
  return sanitizeFilename(last ? decodeURIComponent(last) : undefined);
}

function publicUrl(request: Request, path: string) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}${path}`;
}

function stationApiBase(request: Request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function channelPayload(request: Request, channel: Channel) {
  const encodedName = encodeURIComponent(channel.file.filename);
  const uploadPath = `/api/channels/${channel.id}/upload/${encodedName}`;
  const downloadPath = `/download/${channel.id}/${encodedName}`;
  const humanPath = `/r/${channel.id}`;

  return {
    id: channel.id,
    file: channel.file,
    uploadUrl: publicUrl(request, uploadPath),
    downloadUrl: publicUrl(request, downloadPath),
    humanUrl: publicUrl(request, humanPath),
    eventsUrl: publicUrl(request, `/api/channels/${channel.id}/events`),
    waitingReceivers: activeReceivers(channel).length,
    activeUpload: channel.activeUpload,
    completedTransfers: channel.completedTransfers,
  };
}

function activeReceivers(channel: Channel) {
  channel.receivers = channel.receivers.filter((receiver) => !receiver.closed);
  return channel.receivers;
}

function createChannel(file: Partial<FileDetails>) {
  const channel: Channel = {
    id: makeId(),
    file: {
      filename: sanitizeFilename(file.filename),
      contentType: file.contentType || "application/octet-stream",
      contentLength: Number.isFinite(file.contentLength) ? file.contentLength : undefined,
    },
    receivers: [],
    subscribers: [],
    waitingResolvers: [],
    activeUpload: false,
    createdAt: Date.now(),
    completedTransfers: 0,
    senderKey: makeId(),
    receiverKey: makeId(),
    channelKey: makeId(),
  };

  registerChannel(channel);
  return channel;
}

function registerChannel(channel: Channel) {
  channels.set(channel.id, channel);
  channelsByStationKey.set(channel.id, channel);
  channelsByStationKey.set(channel.channelKey, channel);
  channelsByStationKey.set(channel.senderKey, channel);
  channelsByStationKey.set(channel.receiverKey, channel);
}

function unregisterChannel(channel: Channel) {
  channels.delete(channel.id);
  channelsByStationKey.delete(channel.id);
  channelsByStationKey.delete(channel.channelKey);
  channelsByStationKey.delete(channel.senderKey);
  channelsByStationKey.delete(channel.receiverKey);
}

function closeChannel(channel: Channel) {
  unregisterChannel(channel);
  for (const receiver of activeReceivers(channel)) {
    receiver.closed = true;
    receiver.writer.abort(new Error("Channel closed")).catch(() => {});
  }
  channel.receivers = [];
  for (const subscriber of channel.subscribers) {
    clearInterval(subscriber.heartbeat);
    subscriber.writer.close().catch(() => {});
  }
  channel.subscribers = [];
  for (const resolve of channel.waitingResolvers.splice(0)) resolve();
  emitStationChannelStatus(channel);
}

function notify(channel: Channel) {
  const event = `event: status\ndata: ${JSON.stringify({
    id: channel.id,
    waitingReceivers: activeReceivers(channel).length,
    activeUpload: channel.activeUpload,
    completedTransfers: channel.completedTransfers,
  })}\n\n`;
  const chunk = encoder.encode(event);

  for (const subscriber of channel.subscribers) {
    subscriber.writer.write(chunk).catch(() => {
      clearInterval(subscriber.heartbeat);
      channel.subscribers = channel.subscribers.filter((item) => item.id !== subscriber.id);
    });
  }
}

function stationChannelDetails(request: Request, channel: Channel, perspective: keyof StationKey = "channel") {
  const base = stationApiBase(request);
  const encoded = encodeURIComponent(channel.file.filename);
  return {
    keys: {
      channel_key: perspective === "channel" ? channel.channelKey : undefined,
      sender_key: perspective === "channel" || perspective === "sender" ? channel.senderKey : undefined,
      receiver_key: perspective === "channel" || perspective === "receiver" ? channel.receiverKey : undefined,
    },
    file_details: {
      filename: channel.file.filename,
      content_length: channel.file.contentLength,
      content_type: channel.file.contentType,
    },
    urls: {
      sender_url: `${base}/api/v1/channel/sender/${channel.senderKey}/upload/${encoded}`,
      receiver_url: `${base}/api/v1/channel/receiver/${channel.receiverKey}/download/${encoded}`,
    },
    human_urls: {
      sender_url: `${base}/send/${channel.senderKey}`,
      receiver_url: `${base}/recv/${channel.receiverKey}`,
    },
  };
}

function stationKeyValue(key: StationKey) {
  return key.channel ?? key.sender ?? key.receiver;
}

function keyForChannel(channel: Channel, perspective: keyof StationKey): StationKey {
  if (perspective === "sender") return { sender: channel.senderKey };
  if (perspective === "receiver") return { receiver: channel.receiverKey };
  return { channel: channel.channelKey };
}

function writeSse(writer: WritableStreamDefaultWriter<Uint8Array>, event: string, data: unknown) {
  return writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function cleanupTrackerSubscriber(subscriber: TrackerSubscriber) {
  clearInterval(subscriber.heartbeat);
  trackerSubscribers.delete(subscriber.trackerKey);
}

function emitStationToTracker(trackerKey: string | undefined, event: string, data: unknown) {
  if (!trackerKey) return;
  const subscriber = trackerSubscribers.get(trackerKey);
  if (!subscriber) return;
  writeSse(subscriber.writer, event, data).catch(() => cleanupTrackerSubscriber(subscriber));
}

function emitStationChannelStatus(channel: Channel) {
  const payloads = [
    {
      key: { channel: channel.channelKey },
      receivers_available: activeReceivers(channel).length > 0,
      senders_available: channel.activeUpload,
    },
    {
      key: { sender: channel.senderKey },
      receivers_available: activeReceivers(channel).length > 0,
      senders_available: channel.activeUpload,
    },
    {
      key: { receiver: channel.receiverKey },
      receivers_available: activeReceivers(channel).length > 0,
      senders_available: channel.activeUpload,
    },
  ];

  for (const subscriber of trackerSubscribers.values()) {
    for (const payload of payloads) {
      const key = stationKeyValue(payload.key);
      if (key && subscriber.channelKeys.has(key)) {
        emitStationToTracker(subscriber.trackerKey, "channel_event", { status: payload });
      }
    }
  }
}

function emitTransferEvent(trackerKey: string | undefined, data: unknown) {
  emitStationToTracker(trackerKey, "transfer_event", data);
}

function redirectToUpload(request: Request, channel: Channel) {
  request.body?.cancel?.().catch(() => {});
  const uploadPath = `/api/channels/${channel.id}/upload/${encodeURIComponent(channel.file.filename)}`;
  const downloadPath = `/download/${channel.id}/${encodeURIComponent(channel.file.filename)}`;

  return new Response("AirShare channel created. Following this redirect starts hosting the file.\n", {
    status: 307,
    headers: {
      location: uploadPath,
      "x-airshare-human-url": publicUrl(request, `/r/${channel.id}`),
      "x-airshare-download-url": publicUrl(request, downloadPath),
      "x-airshare-upload-url": publicUrl(request, uploadPath),
    },
  });
}

function redirectToDownload(request: Request, channel: Channel) {
  const downloadPath = `/download/${channel.id}/${encodeURIComponent(channel.file.filename)}`;
  const uploadPath = `/api/channels/${channel.id}/upload/${encodeURIComponent(channel.file.filename)}`;

  return new Response("AirShare receive channel created. Following this redirect waits for a sender.\n", {
    status: 307,
    headers: {
      location: downloadPath,
      "x-airshare-human-upload-url": publicUrl(request, `/s/${channel.id}`),
      "x-airshare-upload-url": publicUrl(request, uploadPath),
      "x-airshare-download-url": publicUrl(request, downloadPath),
    },
  });
}

function applyUploadMetadata(request: Request, channel: Channel) {
  const url = new URL(request.url);
  const uploadMatch = url.pathname.match(/^\/api\/(?:v1\/channel\/sender\/[^/]+\/upload|channels\/[^/]+\/upload)(?:\/(.*))?$/);
  const filename = uploadMatch?.[1]
    ? sanitizeFilename(decodeURIComponent(uploadMatch[1]))
    : channel.file.filename;
  const contentType = request.headers.get("content-type") || channel.file.contentType;
  const uploadLength = positiveInteger(
    request.headers.get("x-airshare-file-size") ?? request.headers.get("x-station307-file-size") ?? request.headers.get("content-length"),
  );

  channel.file = {
    filename,
    contentType,
    contentLength: channel.file.contentLength,
  };

  if (channel.file.contentLength === undefined) {
    channel.file.contentLength = uploadLength;
  }
}

function requestUploadLength(request: Request) {
  return positiveInteger(request.headers.get("content-length"));
}

function advertisedUploadLength(request: Request, channel: Channel) {
  return positiveInteger(request.headers.get("x-airshare-file-size")) ?? positiveInteger(request.headers.get("x-station307-file-size")) ?? channel.file.contentLength;
}

function rejectInvalidUploadLength(request: Request, channel: Channel) {
  const received = requestUploadLength(request);
  const expected = advertisedUploadLength(request, channel);
  if (received === undefined || expected === undefined || received === expected) return null;

  const message = `Upload request body length ${received} does not match advertised file size ${expected}`;
  console.error("Upload length mismatch", {
    channel: channel.id,
    filename: channel.file.filename,
    expected,
    received,
  });

  for (const receiver of activeReceivers(channel)) {
    receiver.closed = true;
    receiver.writer.abort(new Error(message)).catch(() => {});
    emitTransferEvent(receiver.trackerKey, { failed: { tag: receiver.transferTag, reason: "size_mismatch" } });
  }
  channel.receivers = [];
  notify(channel);
  emitStationChannelStatus(channel);

  request.body?.cancel?.().catch(() => {});
  return new Response(message, { status: 400 });
}

function positiveInteger(value: string | null) {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function wakeUploaders(channel: Channel) {
  for (const resolve of channel.waitingResolvers.splice(0)) resolve();
}

async function waitForReceivers(channel: Channel, signal: AbortSignal) {
  while (channels.has(channel.id) && activeReceivers(channel).length === 0) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Upload aborted", "AbortError"));
      };
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        channel.waitingResolvers = channel.waitingResolvers.filter((item) => item !== resolver);
      };
      const resolver = () => {
        cleanup();
        resolve();
      };

      signal.addEventListener("abort", onAbort, { once: true });
      channel.waitingResolvers.push(resolver);
    });
  }

  if (!channels.has(channel.id)) throw new Error("Channel closed");
  const receivers = activeReceivers(channel);
  channel.receivers = [];
  notify(channel);
  emitStationChannelStatus(channel);
  return receivers;
}

async function pumpUploadToReceivers(
  request: Request,
  channel: Channel,
  receivers: Receiver[],
  transferTag?: string,
  trackerKey?: string,
) {
  if (!request.body) throw new Error("Request did not include a body");

  const reader = request.body.getReader();
  let bytes = 0;
  let lastProgress = -1;
  const expected = channel.file.contentLength;

  emitTransferEvent(trackerKey, {
    started: {
      tag: transferTag,
      receiver_count: receivers.filter((receiver) => !receiver.closed).length,
    },
  });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;

      const writes = receivers
        .filter((receiver) => !receiver.closed)
        .map(async (receiver) => {
          try {
            await receiver.writer.write(value);
            receiver.bytesWritten += value.byteLength;
            emitTransferEvent(receiver.trackerKey, {
              progressed: {
                tag: receiver.transferTag,
                bytes_received: receiver.bytesWritten,
                progress: expected ? Math.min(100, Math.round((receiver.bytesWritten / expected) * 100)) : undefined,
              },
            });
          } catch {
            receiver.closed = true;
            emitTransferEvent(trackerKey, { receiver_left: { tag: transferTag } });
          }
        });

      await Promise.all(writes);

      if (transferTag) {
        const progress = expected ? Math.min(100, Math.round((bytes / expected) * 100)) : undefined;
        if (progress !== lastProgress) {
          lastProgress = progress ?? lastProgress;
          emitTransferEvent(trackerKey, {
            progressed: {
              tag: transferTag,
              bytes_sent: bytes,
              progress,
            },
          });
        }
      }
    }

    let successfulReceivers = 0;
    await Promise.all(
      receivers.map(async (receiver) => {
        if (receiver.closed) return;
        receiver.closed = true;
        const wroteUpload = receiver.bytesWritten === bytes;
        const wroteExpected = channel.file.contentLength === undefined || receiver.bytesWritten === channel.file.contentLength;
        if (!wroteUpload || !wroteExpected) {
          await receiver.writer.abort(new Error("Upload ended before the advertised file size was received")).catch(() => {});
          emitTransferEvent(receiver.trackerKey, { failed: { tag: receiver.transferTag, reason: "size_mismatch" } });
          return;
        }
        successfulReceivers += 1;
        await receiver.writer.close().catch(() => {});
        emitTransferEvent(receiver.trackerKey, {
          succeeded: {
            tag: receiver.transferTag,
            bytes_received: receiver.bytesWritten,
          },
        });
      }),
    );

    channel.completedTransfers += successfulReceivers;
    emitTransferEvent(trackerKey, successfulReceivers > 0
      ? { succeeded: { tag: transferTag, bytes_sent: bytes } }
      : { failed: { tag: transferTag, reason: "no_receivers" } });
    return bytes;
  } catch (error) {
    await Promise.all(
      receivers.map(async (receiver) => {
        receiver.closed = true;
        await receiver.writer.abort(error).catch(() => {});
        emitTransferEvent(receiver.trackerKey, { failed: { tag: receiver.transferTag, reason: "upload_failed" } });
      }),
    );
    emitTransferEvent(trackerKey, { failed: { tag: transferTag, reason: "upload_failed" } });
    throw error;
  }
}

async function handleCreateChannel(request: Request) {
  let body: Partial<FileDetails> = {};

  try {
    body = (await request.json()) as Partial<FileDetails>;
  } catch {
    return json({ error: "Expected JSON body" }, { status: 400 });
  }

  const channel = createChannel(body);
  notify(channel);
  emitStationChannelStatus(channel);
  return json(channelPayload(request, channel), { status: 201 });
}

async function handleStationCreateChannel(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON body" }, { status: 400 });
  }

  const file = body?.file_details ?? {};
  const contentLength = Number(file.content_length);
  const channel = createChannel({
    filename: file.filename,
    contentType: file.content_type,
    contentLength: Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : undefined,
  });

  const trackerKey = body?.tracker?.tracker_key;
  const tag = body?.tracker?.tag;
  if (typeof trackerKey === "string" && typeof tag === "string") {
    const subscriber = trackerSubscribers.get(trackerKey);
    subscriber?.channelKeys.add(channel.channelKey);
    emitStationToTracker(trackerKey, "tracker_event", {
      subscribed: {
        tag,
        key: { channel: channel.channelKey },
        channel_details: stationChannelDetails(request, channel, "channel"),
      },
    });
  }

  emitStationChannelStatus(channel);
  return json({ keys: stationChannelDetails(request, channel, "channel").keys }, { status: 201 });
}

function handleChannelEvents(request: Request, channel: Channel) {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const subscriber: Subscriber = {
    id: makeId(),
    writer,
    heartbeat: setInterval(() => {
      writer.write(encoder.encode(`: ping ${Date.now()}\n\n`)).catch(() => {
        clearInterval(subscriber.heartbeat);
        channel.subscribers = channel.subscribers.filter((item) => item.id !== subscriber.id);
      });
    }, 15_000),
  };
  channel.subscribers.push(subscriber);

  request.signal.addEventListener(
    "abort",
    () => {
      clearInterval(subscriber.heartbeat);
      channel.subscribers = channel.subscribers.filter((item) => item.id !== subscriber.id);
      writer.close().catch(() => {});
    },
    { once: true },
  );

  writer.write(encoder.encode(": connected\n\n")).catch(() => {});
  notify(channel);

  return new Response(stream.readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

function handleStationTrack(request: Request) {
  const trackerKey = makeId();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const subscriber: TrackerSubscriber = {
    id: makeId(),
    trackerKey,
    writer,
    channelKeys: new Set(),
    heartbeat: setInterval(() => {
      writeSse(writer, "tracker_event", { ping: Date.now() }).catch(() => cleanupTrackerSubscriber(subscriber));
    }, 5_000),
  };

  trackerSubscribers.set(trackerKey, subscriber);
  request.signal.addEventListener(
    "abort",
    () => {
      cleanupTrackerSubscriber(subscriber);
      writer.close().catch(() => {});
    },
    { once: true },
  );

  writeSse(writer, "tracker_event", { initialized: { tracker_key: trackerKey } }).catch(() => cleanupTrackerSubscriber(subscriber));

  return new Response(stream.readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

async function handleStationSubscribe(request: Request, path: string) {
  const match = path.match(/^\/api\/v1\/channel\/(.+)\/subscribe\/([^/]+)$/);
  if (!match) return notFound();

  const rawRef = match[1];
  const trackerKey = decodeURIComponent(match[2]);
  let perspective: keyof StationKey = "channel";
  let key = rawRef;
  if (rawRef.startsWith("sender/")) {
    perspective = "sender";
    key = rawRef.slice("sender/".length);
  } else if (rawRef.startsWith("receiver/")) {
    perspective = "receiver";
    key = rawRef.slice("receiver/".length);
  }
  key = decodeURIComponent(key);

  const channel = channelsByStationKey.get(key);
  if (!channel) return new Response("Could not load details", { status: 404 });

  const subscriber = trackerSubscribers.get(trackerKey);
  subscriber?.channelKeys.add(key);

  emitStationToTracker(trackerKey, "tracker_event", {
    subscribed: {
      key: keyForChannel(channel, perspective),
      channel_details: stationChannelDetails(request, channel, perspective),
    },
  });
  emitStationChannelStatus(channel);

  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
}

function handleDownload(request: Request, channel: Channel, options: { trackerKey?: string; transferTag?: string } = {}) {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const receiver: Receiver = {
    id: makeId(),
    writer,
    closed: false,
    bytesWritten: 0,
    trackerKey: options.trackerKey,
    transferTag: options.transferTag,
  };
  channel.receivers.push(receiver);

  request.signal.addEventListener(
    "abort",
    () => {
      if (receiver.closed) return;
      receiver.closed = true;
      channel.receivers = channel.receivers.filter((item) => item.id !== receiver.id);
      writer.abort(new Error("Receiver disconnected")).catch(() => {});
      emitTransferEvent(options.trackerKey, { failed: { tag: options.transferTag, reason: "receiver_disconnected" } });
      notify(channel);
      emitStationChannelStatus(channel);
    },
    { once: true },
  );

  wakeUploaders(channel);
  notify(channel);
  emitStationChannelStatus(channel);

  const headers: Record<string, string> = {
    "content-type": channel.file.contentType || "application/octet-stream",
    "content-disposition": contentDisposition(channel.file.filename),
    "cache-control": "no-store",
    "x-airshare-channel": channel.id,
  };
  if (channel.file.contentLength !== undefined) headers["content-length"] = String(channel.file.contentLength);

  return new Response(stream.readable, { headers });
}

async function handleUpload(request: Request, channel: Channel, options: { trackerKey?: string; transferTag?: string } = {}) {
  if (!request.body) return new Response("Upload body required", { status: 400 });
  if (channel.activeUpload) return new Response("Channel is busy", { status: 409 });

  const invalidLengthResponse = rejectInvalidUploadLength(request, channel);
  if (invalidLengthResponse) return invalidLengthResponse;

  applyUploadMetadata(request, channel);
  channel.activeUpload = true;
  notify(channel);
  emitStationChannelStatus(channel);

  try {
    const receivers = await waitForReceivers(channel, request.signal);
    const bytes = await pumpUploadToReceivers(request, channel, receivers, options.transferTag, options.trackerKey);
    if (channel.file.contentLength !== undefined && bytes !== channel.file.contentLength) {
      console.error("Transfer size mismatch", {
        channel: channel.id,
        filename: channel.file.filename,
        expected: channel.file.contentLength,
        actual: bytes,
      });
      return new Response(
        `Transfer failed: expected ${channel.file.contentLength} bytes but received ${bytes} bytes`,
        { status: 400 },
      );
    }
  } catch (error) {
    console.error("Transfer failed", error);
    if ((error as Error).name === "AbortError") return new Response("Upload cancelled", { status: 499 });
    return new Response(`Transfer failed: ${(error as Error).message}`, { status: 500 });
  } finally {
    channel.activeUpload = false;
    notify(channel);
    emitStationChannelStatus(channel);
  }

  const noRedirect = request.headers.get("x-airshare-no-redirect") === "1" || request.headers.get("x-station307-no-redirect") === "1" || request.headers.get("com.station307.no-redirect") === "true";
  if (noRedirect) return new Response(null, { status: 204 });

  return new Response("Transfer complete. Waiting for another receiver.\n", {
    status: 200,
    headers: {
      "x-airshare-human-url": publicUrl(request, `/r/${channel.id}`),
      "x-airshare-download-url": publicUrl(request, `/download/${channel.id}/${encodeURIComponent(channel.file.filename)}`),
    },
  });
}

async function serveStaticFrom(base: URL, pathname: string) {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad path", { status: 400 });
  }

  if (decodedPathname.split("/").includes("..")) return notFound();

  let filePath = decodedPathname === "/" ? "index.html" : decodedPathname.slice(1);
  if (!filePath || filePath.endsWith("/")) filePath += "index.html";
  const file = Bun.file(new URL(filePath, base));
  if (!(await file.exists())) return null;

  const extension = filePath.match(/\.[^.]*$/)?.[0]?.toLowerCase() ?? "";
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (STATIC_TYPES[extension]) headers["content-type"] = STATIC_TYPES[extension];

  return new Response(file, { headers });
}

async function serveStatic(pathname: string) {
  return serveStaticFrom(PUBLIC_DIR, pathname);
}

function renderReceiverPage(request: Request, channel: Channel) {
  const payload = channelPayload(request, channel);
  const escaped = JSON.stringify(payload).replace(/</g, "\\u003c");
  const filename = escapeHtml(channel.file.filename);

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${filename} - AirShare</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <nav class="nav-pills" aria-label="Primary">
        <a href="/">Home</a>
        <a href="/#recipes">Recipes</a>
        <a href="/#about">About</a>
      </nav>
    </div>
  </header>
  <main>
    <section class="jumbotron compact-jumbotron">
      <div class="container">
        <h1>AirShare</h1>
        <p>Someone shared a file with you.</p>
      </div>
    </section>

    <section class="container transfer-page">
      <div class="transfer-card">
        <h4>Ready to receive</h4>
        <h1>${filename}</h1>
        <p class="muted">This page waits for the sender tab or terminal command, then streams the file directly to you.</p>
        <a id="download" class="primary" href="${payload.downloadUrl}">Download file</a>
        <p id="status" class="transfer-status">Waiting for you to start the download.</p>
      </div>
    </section>
  </main>
  <script>window.STATION_CHANNEL=${escaped};</script>
  <script src="/receiver.js" defer></script>
</body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function renderSenderPage(request: Request, channel: Channel) {
  const payload = channelPayload(request, channel);
  const escaped = JSON.stringify(payload).replace(/</g, "\\u003c");

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Send a file - AirShare</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <nav class="nav-pills" aria-label="Primary">
        <a href="/">Home</a>
        <a href="/#recipes">Recipes</a>
        <a href="/#about">About</a>
      </nav>
    </div>
  </header>
  <main>
    <section class="jumbotron compact-jumbotron">
      <div class="container">
        <h1>AirShare</h1>
        <p>A receiver is waiting for this file.</p>
      </div>
    </section>

    <section class="container transfer-page">
      <div class="transfer-card">
        <h4>Receiver waiting</h4>
        <h1>Send a file</h1>
        <p class="muted">Choose a file and keep this tab open while AirShare streams it to the waiting receiver.</p>
        <label class="add-file compact" for="send-file">
          <input id="send-file" type="file">
          <p>Select file</p>
        </label>
        <p id="status" class="transfer-status">Waiting for a file.</p>
      </div>
    </section>
  </main>
  <script>window.STATION_CHANNEL=${escaped};</script>
  <script src="/sender.js" defer></script>
</body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,x-airshare-no-redirect,x-airshare-file-size,x-station307-no-redirect,x-station307-file-size,com.station307.tracker,com.station307.tag,com.station307.no-redirect",
        },
      });
    }

    if (request.method === "GET" && pathname === "/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js") {
      return new Response(CLOUDFLARE_EMAIL_DECODE_JS, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (request.method === "GET" && pathname === "/api/v1/track") {
      return handleStationTrack(request);
    }

    if (request.method === "POST" && pathname === "/api/v1/channel") {
      return handleStationCreateChannel(request);
    }

    if (request.method === "POST" && pathname.match(/^\/api\/v1\/channel\/.+\/subscribe\/[^/]+$/)) {
      return handleStationSubscribe(request, pathname);
    }

    const stationUploadMatch = pathname.match(/^\/api\/v1\/channel\/sender\/([^/]+)\/upload(?:\/.*)?$/);
    if ((request.method === "POST" || request.method === "PUT") && stationUploadMatch) {
      const channel = channelsByStationKey.get(decodeURIComponent(stationUploadMatch[1]));
      if (!channel) return new Response("Channel not found", { status: 404 });
      return handleUpload(request, channel, {
        trackerKey: request.headers.get("com.station307.tracker") ?? undefined,
        transferTag: request.headers.get("com.station307.tag") ?? undefined,
      });
    }

    const stationDownloadMatch = pathname.match(/^\/api\/v1\/channel\/receiver\/([^/]+)\/download(?:\/.*)?$/);
    if (request.method === "GET" && stationDownloadMatch) {
      const channel = channelsByStationKey.get(decodeURIComponent(stationDownloadMatch[1]));
      if (!channel) return new Response("Channel not found", { status: 404 });
      return handleDownload(request, channel);
    }

    if (request.method === "POST" && pathname === "/api/channels") {
      return handleCreateChannel(request);
    }

    if (pathname === "/xfr" && request.method === "GET") {
      const channel = createChannel({ filename: "airshare-download" });
      return redirectToDownload(request, channel);
    }

    if (pathname === "/xfr" && (request.method === "POST" || request.method === "PUT")) {
      const channel = createChannel({
        filename: sanitizeFilename(request.headers.get("x-airshare-filename") || request.headers.get("x-station307-filename") || undefined),
        contentType: request.headers.get("content-type") || "application/octet-stream",
        contentLength: Number(request.headers.get("content-length")) || undefined,
      });
      return redirectToUpload(request, channel);
    }

    const apiChannelMatch = pathname.match(/^\/api\/channels\/([^/]+)(?:\/(.*))?$/);
    if (apiChannelMatch) {
      const channel = channels.get(apiChannelMatch[1]);
      if (!channel) return json({ error: "Channel not found" }, { status: 404 });

      const action = apiChannelMatch[2] ?? "";
      if (request.method === "GET" && action === "") return json(channelPayload(request, channel));
      if (request.method === "GET" && action === "events") return handleChannelEvents(request, channel);
      if (request.method === "DELETE" && action === "") {
        closeChannel(channel);
        return new Response(null, { status: 204 });
      }
      if ((request.method === "POST" || request.method === "PUT") && action.startsWith("upload")) {
        return handleUpload(request, channel);
      }
    }

    const downloadMatch = pathname.match(/^\/download\/([^/]+)(?:\/.*)?$/);
    if (request.method === "GET" && downloadMatch) {
      const channel = channels.get(downloadMatch[1]);
      if (!channel) return new Response("This AirShare channel is not available.", { status: 404 });
      return handleDownload(request, channel);
    }

    const receiverMatch = pathname.match(/^\/r\/([^/]+)$/);
    if (request.method === "GET" && receiverMatch) {
      const channel = channels.get(receiverMatch[1]);
      if (!channel) return new Response("This AirShare channel is not available.", { status: 404 });
      return renderReceiverPage(request, channel);
    }

    const stationReceiverMatch = pathname.match(/^\/recv\/([^/]+)$/);
    if (request.method === "GET" && stationReceiverMatch) {
      const channel = channelsByStationKey.get(decodeURIComponent(stationReceiverMatch[1]));
      if (!channel) return new Response("This AirShare channel is not available.", { status: 404 });
      return renderReceiverPage(request, channel);
    }

    const senderMatch = pathname.match(/^\/s\/([^/]+)$/);
    if (request.method === "GET" && senderMatch) {
      const channel = channels.get(senderMatch[1]);
      if (!channel) return new Response("This AirShare channel is not available.", { status: 404 });
      return renderSenderPage(request, channel);
    }

    const stationSenderMatch = pathname.match(/^\/send\/([^/]+)$/);
    if (request.method === "GET" && stationSenderMatch) {
      const channel = channelsByStationKey.get(decodeURIComponent(stationSenderMatch[1]));
      if (!channel) return new Response("This AirShare channel is not available.", { status: 404 });
      return renderSenderPage(request, channel);
    }

    if ((request.method === "POST" || request.method === "PUT") && !pathname.startsWith("/api")) {
      const filename = fileFromPath(pathname);
      const channel = createChannel({
        filename,
        contentType: request.headers.get("content-type") || "application/octet-stream",
        contentLength: Number(request.headers.get("content-length")) || undefined,
      });

      return redirectToUpload(request, channel);
    }

    const staticResponse = await serveStatic(pathname);
    if (staticResponse) return staticResponse;

    if (pathname === "/tos" || pathname === "/privacy" || pathname === "/about" || pathname === "/recipes" || pathname === "/share") {
      return notFound();
    }

    return notFound();
  },
});

console.log(`AirShare listening on http://localhost:${server.port}`);
