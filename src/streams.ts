import { randomKey } from "./capability-keys";
import {
  channelPayload,
  closedReason,
  hostingEnded,
  keyFor,
  lookup,
  noteProtection,
  origin,
  persist,
  protectedChannel,
  refreshHost,
  senderOnline,
  setLease,
} from "./channels";
import {
  closeMessages,
  type App,
  type Capability,
  type Channel,
  type CloseReason,
  type NativeSubscriber,
  type Role,
  type Sse,
  type Tracker,
} from "./context";
import { asError, attempt, encoder, HttpError, json, readJson, record, streamHeaders } from "./responses";
import { stationDetails, stationKey, stationStatus } from "./station";

export function sse(
  app: App,
  request: Request,
  onClose: () => void,
  heartbeat?: () => void,
  heartbeatMs = 15_000,
): Sse {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stop = (error?: Error) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    request.signal.removeEventListener("abort", onAbort);
    app.subscriberCount--;
    try {
      if (error) controller.error(error);
      else controller.close();
    } catch {
      /* The HTTP consumer may already have cancelled the stream. */
    } finally {
      onClose();
    }
  };
  const onAbort = () => stop(new Error("Subscriber disconnected"));
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      cancel() {
        stop();
      },
    },
    { highWaterMark: app.config.streamHighWaterMark, size: (chunk) => chunk?.byteLength ?? 0 },
  );
  const send = (event: string, data: unknown) => {
    if (closed) return false;
    const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if ((controller.desiredSize ?? 0) < chunk.byteLength) {
      stop(new Error("Subscriber is too slow"));
      return false;
    }
    controller.enqueue(chunk);
    return true;
  };
  const timer = setInterval(() => {
    if (heartbeat) heartbeat();
    else if (!closed) {
      const chunk = encoder.encode(": ping\n\n");
      if ((controller.desiredSize ?? 0) < chunk.byteLength) stop(new Error("Subscriber is too slow"));
      else controller.enqueue(chunk);
    }
  }, heartbeatMs);
  timer.unref();
  app.subscriberCount++;
  request.signal.addEventListener("abort", onAbort, { once: true });
  const response = new Response(stream, {
    headers: { ...streamHeaders, "content-type": "text/event-stream; charset=utf-8" },
  });
  return { send, finish: () => stop(), response };
}
function trackerStatus(channel: Channel, tracker: Tracker, role: Role) {
  if (tracker.native) tracker.sse.send("status", channelPayload(channel, role, tracker.origin));
  else stationStatus(channel, tracker, role);
}
export function notify(app: App, channel: Channel) {
  if (channel.closed) return;
  // Timers and stream callbacks call this, where a throw would end the process.
  try {
    channel.announcedOnline = senderOnline(channel);
    if (protectedChannel(channel)) noteProtection(app, channel);
    for (const subscriber of channel.subscribers)
      subscriber.sse.send("status", channelPayload(channel, subscriber.role, subscriber.origin));
    for (const [tracker, roles] of channel.trackers)
      for (const role of roles.keys()) trackerStatus(channel, tracker, role);
  } catch (error) {
    console.error("A share's status could not be sent:", asError(error).message);
  }
}
function channelSubscriberCount(channel: Channel) {
  return channel.subscribers.size + [...channel.trackers.values()].reduce((sum, roles) => sum + roles.size, 0);
}
export function nativeEvents(app: App, request: Request, capability: Capability) {
  const { channel, role } = capability;
  if (request.signal.aborted) throw new HttpError(499, "Request cancelled");
  if (
    app.subscriberCount >= app.config.maxSubscribers ||
    channelSubscriberCount(channel) >= app.config.maxSubscribersPerChannel
  ) {
    throw new HttpError(429, "Subscriber limit reached");
  }
  const clientRelease = app.admission.leaseClient(request, "subscriber");
  if (!clientRelease) throw new HttpError(429, "Client subscriber limit reached");
  const hosting = role !== "receiver" && new URL(request.url).searchParams.get("hosting") === "1";
  const subscriber: NativeSubscriber = { role, origin: origin(app, request), hosting, sse: undefined! };
  subscriber.sse = sse(app, request, () => {
    // Runs when the stream ends, from an abort or a heartbeat timer, so a failed save must not stop the cleanup.
    if (subscriber.hosting) {
      attempt(() => noteProtection(app, channel));
      attempt(() => persist(app, channel));
    }
    clientRelease();
    channel.subscribers.delete(subscriber);
    refreshHost(app, channel);
    if (subscriber.hosting) hostingEnded(app, channel);
    queueMicrotask(() => notify(app, channel));
  });
  channel.subscribers.add(subscriber);
  refreshHost(app, channel);
  notify(app, channel);
  return subscriber.sse.response;
}
export function track(app: App, request: Request) {
  if (request.signal.aborted) throw new HttpError(499, "Request cancelled");
  const format = new URL(request.url).searchParams.get("format");
  if (format !== null && format !== "native" && format !== "station")
    throw new HttpError(400, "format must be native or station");
  if (app.subscriberCount >= app.config.maxSubscribers) throw new HttpError(429, "Subscriber limit reached");
  const clientRelease = app.admission.leaseClient(request, "subscriber");
  if (!clientRelease) throw new HttpError(429, "Client subscriber limit reached");
  const tracker: Tracker = {
    id: randomKey(),
    sse: undefined!,
    subscriptions: new Map(),
    origin: origin(app, request),
    native: format === "native",
  };
  tracker.sse = sse(
    app,
    request,
    () => {
      clientRelease();
      app.trackers.delete(tracker.id);
      const affected = new Set<Channel>();
      const hosted = new Set<Channel>();
      for (const { channel, role } of tracker.subscriptions.values()) {
        if (channel.trackers.get(tracker)?.get(role)) {
          attempt(() => noteProtection(app, channel));
          attempt(() => persist(app, channel));
          hosted.add(channel);
        }
        affected.add(channel);
      }
      for (const channel of affected) {
        channel.trackers.delete(tracker);
        refreshHost(app, channel);
        if (hosted.has(channel)) hostingEnded(app, channel);
        queueMicrotask(() => notify(app, channel));
      }
      tracker.subscriptions.clear();
    },
    () => tracker.sse.send("tracker_event", { ping: tracker.native ? Date.now() : {} }),
    tracker.native ? 5000 : 3000,
  );
  app.trackers.set(tracker.id, tracker);
  tracker.sse.send("tracker_event", { initialized: { tracker_key: tracker.id } });
  return tracker.sse.response;
}
/** Subscribes or re-subscribes a key. Station owner/sender subscriptions always host; native ones host only when asked. */
export function subscribe(
  app: App,
  tracker: Tracker,
  capability: Capability,
  { tag, hosting = false }: { tag?: string; hosting?: boolean } = {},
) {
  const { channel, role } = capability;
  const key = keyFor(channel, role);
  if (!tracker.subscriptions.has(key)) {
    if (
      tracker.subscriptions.size >= app.config.maxTrackerChannels ||
      channelSubscriberCount(channel) >= app.config.maxSubscribersPerChannel
    ) {
      throw new HttpError(429, "Subscription limit reached", "subscription_limit");
    }
    tracker.subscriptions.set(key, capability);
  }
  let channelRoles = channel.trackers.get(tracker);
  if (!channelRoles) channel.trackers.set(tracker, (channelRoles = new Map()));
  const host = role !== "receiver" && (!tracker.native || hosting);
  const stoppedHosting = channelRoles.get(role) && !host;
  if (stoppedHosting) {
    noteProtection(app, channel);
    persist(app, channel);
  }
  channelRoles.set(role, host);
  refreshHost(app, channel);
  if (stoppedHosting) hostingEnded(app, channel);
  const subscribed = {
    ...(tag ? { tag } : {}),
    key: stationKey(channel, role),
    channel_details: stationDetails(channel, role, tracker.origin),
  };
  tracker.sse.send("tracker_event", { subscribed });
  notify(app, channel);
}
export function unsubscribe(app: App, tracker: Tracker, capability: Capability) {
  const { channel, role } = capability;
  if (!tracker.subscriptions.delete(keyFor(channel, role))) return;
  const channelRoles = channel.trackers.get(tracker);
  const wasHosting = channelRoles?.get(role);
  if (wasHosting) {
    noteProtection(app, channel);
    persist(app, channel);
  }
  channelRoles?.delete(role);
  if (channelRoles?.size === 0) channel.trackers.delete(tracker);
  refreshHost(app, channel);
  if (wasHosting) hostingEnded(app, channel);
  notify(app, channel);
}
/**
 * Fallback for pages without a status stream: renews (or releases) many sender presence leases in one request and
 * returns every key's status, so a page with many shares needs one poll instead of one per share.
 */
export async function presence(app: App, request: Request) {
  const { config } = app;
  const body = record(await readJson(app, request), "Presence request");
  const keys = body.keys;
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || key.length > 128))
    throw new HttpError(400, "keys must be an array of key strings");
  // The page splits its batch on this answer, so it names the limit rather than only refusing.
  if (keys.length > config.maxPresenceKeys) {
    const error = `At most ${config.maxPresenceKeys} keys per presence request`;
    return json({ error, reason: "too_many_keys", max: config.maxPresenceKeys, retryable: false }, 400);
  }
  if (body.hosting !== undefined && typeof body.hosting !== "boolean")
    throw new HttpError(400, "hosting must be a boolean");
  const statuses: Record<string, unknown> = {};
  const closed: Record<string, { error: string; reason: CloseReason }> = {};
  const unknown: string[] = [];
  for (const key of new Set(keys as string[])) {
    const capability = lookup(app, key);
    if (!capability) {
      const reason = closedReason(app, key);
      if (reason) closed[key] = { error: closeMessages[reason], reason };
      else unknown.push(key);
      continue;
    }
    const { channel, role } = capability;
    if (role !== "receiver" && body.hosting === true) {
      setLease(app, channel, Date.now() + config.senderLease);
      noteProtection(app, channel);
    } else if (role !== "receiver" && body.hosting === false && channel.senderLeaseUntil > Date.now()) {
      noteProtection(app, channel);
      setLease(app, channel, 0);
      persist(app, channel);
    }
    statuses[key] = channelPayload(channel, role, origin(app, request));
  }
  return json({ channels: statuses, closed, unknown });
}
export function hostingParameter(url: URL) {
  const value = url.searchParams.get("hosting");
  if (value !== null && value !== "0" && value !== "1") throw new HttpError(400, "hosting must be 0 or 1");
  return value === "1";
}
