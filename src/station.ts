import { keyFor, shortDownloadUrl, shortUploadUrl } from "./channels";
import type { App, Channel, Role, Tracker, TransferOptions } from "./context";
import type { FileDetails } from "./metadata-store";
import { HttpError } from "./responses";

export function stationKey(channel: Channel, role: Role) {
  return { [role === "owner" ? "channel" : role]: keyFor(channel, role) };
}
export function stationDetails(channel: Channel, role: Role, base: string) {
  const name = encodeURIComponent(channel.file.filename);
  return {
    keys: {
      ...(role === "owner" ? { channel_key: keyFor(channel, "owner") } : {}),
      ...(role !== "receiver" ? { sender_key: keyFor(channel, "sender") } : {}),
      ...(role !== "sender" ? { receiver_key: keyFor(channel, "receiver") } : {}),
    },
    file_details: {
      filename: channel.file.filename,
      content_type: channel.file.contentType,
      content_length: channel.file.contentLength,
    },
    urls: {
      sender_url: role !== "receiver" ? shortUploadUrl(base, channel, name) : null,
      receiver_url: shortDownloadUrl(base, channel, name),
    },
    human_urls: {
      ...(role !== "receiver" ? { sender_url: `${base}/send/${keyFor(channel, "sender")}` } : {}),
      receiver_url: `${base}/recv/${keyFor(channel, "receiver")}`,
    },
  };
}
/** Station semantics: senders_available means an upload is waiting for receivers, not that a sender page is open. */
export function stationStatus(channel: Channel, tracker: Tracker, role: Role) {
  const sendersAvailable = !channel.closed && !!channel.upload && !channel.upload.started;
  const status = {
    key: stationKey(channel, role),
    ...(role !== "receiver" ? { receivers_available: channel.waiting.size > 0 } : {}),
    senders_available: sendersAvailable,
  };
  tracker.sse.send("channel_event", { status });
}
export function transferEvent(app: App, options: TransferOptions, event: unknown) {
  if (options.trackerKey) app.trackers.get(options.trackerKey)?.sse.send("transfer_event", event);
}
export function occurredAt() {
  return new Date().toISOString();
}
export function fileFields(file: Readonly<FileDetails>) {
  return { filename: file.filename, content_type: file.contentType, file_size: file.contentLength ?? null };
}
export function transferOptions(request: Request): TransferOptions {
  const query = new URL(request.url).searchParams;
  const trackerKey =
    request.headers.get("com.station307.tracker") ?? query.get("com.station307.tracker") ?? query.get("tracker");
  const transferTag = request.headers.get("com.station307.tag") ?? query.get("com.station307.tag") ?? query.get("tag");
  for (const value of [trackerKey, transferTag]) {
    if (value !== null && (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)))
      throw new HttpError(400, "Invalid transfer tracking value");
  }
  return { trackerKey: trackerKey ?? undefined, transferTag: transferTag ?? undefined };
}
