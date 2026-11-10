import { keyHash, randomKey, seal, unseal } from "./capability-keys";
import { closeMessages, roles, type App, type Capability, type Channel, type CloseReason, type Role } from "./context";
import { UNNAMED_FILE } from "./filenames";
import type { ChannelMetadata, FileDetails } from "./metadata-store";
import { failReceiver } from "./relay";
import { asError, attempt, HttpError, json, notFound } from "./responses";
import { stationKey, stationStatus } from "./station";
import { notify } from "./streams";

/** The origin links are built on: PUBLIC_URL when set, otherwise the request's own. */
export function origin(app: App, request: Request) {
  return app.config.publicOrigin ?? new URL(request.url).origin;
}

function gone(reason: CloseReason) {
  return json({ error: closeMessages[reason], reason }, 410);
}
const CLOSED_KEY_TTL = 3_600_000;
function rememberClosed(app: App, channel: Channel, reason: CloseReason) {
  const at = Date.now();
  for (const role of roles) {
    const hash = channel.keys[role];
    app.closedKeys.delete(hash);
    app.closedKeys.set(hash, { reason, role, at });
  }
  // Every channel leaves three keys behind, so this covers a full house of closed channels.
  while (app.closedKeys.size > 3 * app.config.maxChannels) app.closedKeys.delete(app.closedKeys.keys().next().value!);
}
export function closedRecord(app: App, key: string) {
  const hash = keyHash(key);
  const record = app.closedKeys.get(hash);
  if (record && Date.now() - record.at >= CLOSED_KEY_TTL) {
    app.closedKeys.delete(hash);
    return;
  }
  return record;
}
/** Why a recently closed owner, sender or receiver key stopped working, for one hour after closing. */
export function closedReason(app: App, key: string): CloseReason | undefined {
  return closedRecord(app, key)?.reason;
}
export function missing(app: App, key: string, allowed?: Role[]) {
  const record = closedRecord(app, key);
  return record && (!allowed || allowed.includes(record.role)) ? gone(record.reason) : notFound();
}

export function keyFor(channel: Channel, role: Role) {
  const key = channel.known[role];
  if (key === undefined) throw new Error(`The ${role} key of this share is not known yet`);
  return key;
}
function open(sealed: string, under: string, hash: string) {
  const key = unseal(sealed, under);
  if (keyHash(key) !== hash) throw new Error("the unsealed key does not match its stored hash");
  return key;
}
/** Holding a key opens the keys below it: owner, then sender, then receiver. False when a stored key can't be recovered. */
function learn(channel: Channel, role: Role, key: string) {
  const { known, keys } = channel;
  known[role] ??= key;
  try {
    if (known.sender === undefined && known.owner !== undefined)
      known.sender = open(keys.senderSealed, known.owner, keys.sender);
    if (known.receiver === undefined && known.sender !== undefined)
      known.receiver = open(keys.receiverSealed, known.sender, keys.receiver);
    return true;
  } catch (error) {
    console.error("A stored share key could not be recovered:", error instanceof Error ? error.message : error);
    return false;
  }
}
export function shortUploadUrl(base: string, channel: Channel, name: string) {
  return `${base}/u/${keyFor(channel, "sender")}/${name}`;
}
export function shortDownloadUrl(base: string, channel: Channel, name: string) {
  return `${base}/l/${keyFor(channel, "receiver")}/${name}`;
}
export function senderOnline(channel: Channel) {
  return (
    !!channel.upload ||
    channel.senderLeaseUntil > Date.now() ||
    [...channel.subscribers].some((item) => item.hosting) ||
    [...channel.trackers.values()].some((roles) => [...roles.values()].some(Boolean))
  );
}
export function channelReceiverCount(channel: Channel) {
  return channel.waiting.size + (channel.upload?.receivers.size ?? 0);
}
export function channelPayload(channel: Channel, role: Role, base: string) {
  const key = keyFor(channel, role);
  const name = encodeURIComponent(channel.file.filename);
  return {
    id: key,
    role,
    file: channel.file,
    ...(role !== "receiver" ? { uploadUrl: shortUploadUrl(base, channel, name) } : {}),
    downloadUrl: shortDownloadUrl(base, channel, name),
    humanUrl: `${base}/r/${keyFor(channel, "receiver")}`,
    eventsUrl: `${base}/api/channels/${key}/events`,
    statusUrl: `${base}/api/channels/${key}`,
    ...(role === "owner" ? { deleteUrl: `${base}/api/channels/${key}` } : {}),
    ...(role !== "receiver" ? { hostBound: channel.hostBound } : {}),
    waitingReceivers: channel.waiting.size,
    activeReceivers: channel.upload?.receivers.size ?? 0,
    activeUpload: !!channel.upload,
    completedTransfers: channel.completedTransfers,
    senderOnline: senderOnline(channel),
    bytesTransferred: channel.upload?.bytes ?? 0,
    ...(role !== "receiver" && channel.lastError ? { lastError: channel.lastError } : {}),
    ...(role !== "receiver"
      ? {
          activeUploadId: channel.upload?.uploadId,
          lastUploadId: channel.lastUpload?.id,
          lastUploadReason: channel.lastUpload?.reason,
          lastUploadRetryable: channel.lastUpload?.retryable,
          lastUploadError: channel.lastUpload?.error,
        }
      : {}),
  };
}

export function register(app: App, metadata: ChannelMetadata, known: Partial<Record<Role, string>> = {}): Channel {
  const channel: Channel = {
    ...metadata,
    known,
    waiting: new Set(),
    subscribers: new Set(),
    trackers: new Map(),
    closed: false,
    lastPersisted: metadata.lastTouched,
    senderLeaseUntil: 0,
    creating: false,
    hostOnline: false,
    lastHostSeenAt: Date.now(),
    announcedOnline: false,
  };
  app.channels.set(channel.keys.owner, channel);
  if (channel.clientQuotaId)
    app.clientChannelCounts.set(channel.clientQuotaId, (app.clientChannelCounts.get(channel.clientQuotaId) ?? 0) + 1);
  for (const role of roles) app.capabilities.set(channel.keys[role], { channel, role });
  // New and restored host-bound channels get one grace period for their tab to (re)connect.
  scheduleHostCheck(app, channel);
  return channel;
}
export function persist(app: App, channel: Channel) {
  if (!channel.closed && !app.storeClosed) {
    app.store.save(channel);
    channel.lastPersisted = channel.lastTouched;
  }
}
export function touch(app: App, channel: Channel) {
  if (app.stopping) return;
  const { config } = app;
  channel.lastTouched = Date.now();
  const interval = Math.min(30_000, config.channelTtl / 2, unused(channel) ? config.unusedChannelTtl / 2 : Infinity);
  if (channel.lastTouched - channel.lastPersisted >= interval) persist(app, channel);
}
export function protectedChannel(channel: Channel) {
  return channel.creating || !!channel.upload || channel.waiting.size > 0 || senderOnline(channel);
}
export function unused(channel: Channel) {
  return channel.usedAt === undefined && channel.completedTransfers === 0;
}
export function noteProtection(app: App, channel: Channel) {
  channel.lastProtectedAt = Date.now();
  touch(app, channel);
}
function idleSince(channel: Channel) {
  return Math.max(channel.lastProtectedAt ?? channel.createdAt, channel.senderLeaseUntil);
}
/** Channel life is measured from activity (protection, hosting, transfers), never from reads. */
function expired(app: App, channel: Channel) {
  const { config } = app;
  if (protectedChannel(channel)) {
    noteProtection(app, channel);
    return false;
  }
  return unused(channel)
    ? Date.now() - idleSince(channel) >= Math.min(config.unusedChannelTtl, config.channelTtl)
    : Date.now() - channel.lastTouched >= config.channelTtl;
}
export function refreshHost(app: App, channel: Channel) {
  if (channel.closed || app.stopping) return;
  const online = senderOnline(channel);
  if (online || channel.hostOnline) channel.lastHostSeenAt = Date.now();
  channel.hostOnline = online;
  if (online) {
    clearTimeout(channel.hostTimer);
    channel.hostTimer = undefined;
  } else scheduleHostCheck(app, channel);
}
function scheduleHostCheck(app: App, channel: Channel) {
  if (!channel.hostBound || channel.closed || app.stopping || channel.hostTimer || channel.hostOnline) return;
  channel.hostTimer = setTimeout(
    () => {
      channel.hostTimer = undefined;
      // A throw here would end the process; after a failure (a full disk) the cleanup sweep checks the share again.
      attempt(() => {
        if (abandoned(app, channel)) closeChannel(app, channel, "sender_left");
        else scheduleHostCheck(app, channel);
      });
    },
    Math.max(0, channel.lastHostSeenAt + app.config.hostGrace - Date.now()),
  );
  channel.hostTimer.unref();
}
function abandoned(app: App, channel: Channel) {
  if (!channel.hostBound || channel.closed) return false;
  refreshHost(app, channel);
  return !channel.hostOnline && Date.now() - channel.lastHostSeenAt >= app.config.hostGrace;
}
/** Announces availability only when it changes, so lease renewals stay quiet. */
function hostChanged(app: App, channel: Channel) {
  refreshHost(app, channel);
  if (!channel.closed && senderOnline(channel) !== channel.announcedOnline) notify(app, channel);
}
/** A lease renewed beside a hosting stream belongs to the same page, so it ends with that stream. */
export function hostingEnded(app: App, channel: Channel) {
  if (channel.senderLeaseUntil) setLease(app, channel, 0);
}
export function setLease(app: App, channel: Channel, until: number) {
  channel.senderLeaseUntil = until;
  clearTimeout(channel.leaseTimer);
  channel.leaseTimer = undefined;
  if (until > Date.now()) {
    channel.leaseTimer = setTimeout(
      () => {
        channel.leaseTimer = undefined;
        attempt(() => hostChanged(app, channel));
      },
      until - Date.now() + 1,
    );
    channel.leaseTimer.unref();
  }
  hostChanged(app, channel);
}
export function lookup(app: App, key: string, allowed?: Role[]): Capability | undefined {
  const capability = app.capabilities.get(keyHash(key));
  if (!capability) return;
  // Without the keys below it the share can't build its links, so it ends rather than fail on every status.
  if (!learn(capability.channel, capability.role, key)) {
    closeChannel(app, capability.channel, "expired");
    return;
  }
  if (abandoned(app, capability.channel)) {
    closeChannel(app, capability.channel, "sender_left");
    return;
  }
  if (expired(app, capability.channel)) {
    closeChannel(app, capability.channel, "expired");
    return;
  }
  if (allowed && !allowed.includes(capability.role)) return;
  return capability;
}
export function cleanupExpired(app: App) {
  flushDeletes(app);
  for (const channel of app.channels.values()) {
    // Runs from a timer: a failed save (a full disk) is logged, and the next sweep tries again.
    attempt(() => {
      if (abandoned(app, channel)) closeChannel(app, channel, "sender_left");
      else if (expired(app, channel)) closeChannel(app, channel, "expired");
    });
  }
}
/** A closed share whose row couldn't be deleted (a full disk) would return after a restart, so the delete is retried. */
function forget(app: App, ownerHash: string) {
  try {
    app.store.delete(ownerHash);
    app.pendingDeletes.delete(ownerHash);
  } catch (error) {
    app.pendingDeletes.add(ownerHash);
    console.error(
      "A closed share could not be removed from the database; retrying on the next sweep:",
      asError(error).message,
    );
  }
}
export function flushDeletes(app: App) {
  if (!app.storeClosed) for (const ownerHash of [...app.pendingDeletes]) forget(app, ownerHash);
}
export function createChannel(app: App, request: Request, file: FileDetails, hostBound = false) {
  // Browsers label every request. A link, image or frame on another site sends no Origin with a GET, but this header still tells.
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site")
    throw new HttpError(403, "Requests from other websites can't create shares", "cross_origin");
  const { config, channels } = app;
  const retryAfter = app.admission.admitCreation(request);
  if (retryAfter) throw new HttpError(429, "Channel creation rate exceeded", "creation_rate", retryAfter);
  const clientQuotaId = new Bun.CryptoHasher("sha256")
    .update(`airshare-client-v1:${app.admission.clientIdentity(request)}`)
    .digest("hex");
  const atClientQuota = () =>
    config.maxChannelsPerClient && (app.clientChannelCounts.get(clientQuotaId) ?? 0) >= config.maxChannelsPerClient;
  // A sweep visits every channel, so creation runs one only when a limit is reached; the interval sweep handles the rest.
  if (channels.size >= config.maxChannels || atClientQuota()) cleanupExpired(app);
  if (atClientQuota())
    throw new HttpError(
      429,
      "Client channel quota reached; close unused shares or wait for expiry",
      "channel_quota",
      60,
    );
  if (channels.size >= config.maxChannels) {
    let oldest: Channel | undefined;
    for (const candidate of channels.values()) {
      if (unused(candidate) && !protectedChannel(candidate) && (!oldest || idleSince(candidate) < idleSince(oldest)))
        oldest = candidate;
    }
    if (oldest) closeChannel(app, oldest, "capacity");
  }
  if (channels.size >= config.maxChannels)
    throw new HttpError(503, "Channel capacity reached; retry after unused channels expire");
  const now = Date.now();
  const known = { owner: randomKey(), sender: randomKey(), receiver: randomKey() };
  const keys = {
    owner: keyHash(known.owner),
    sender: keyHash(known.sender),
    receiver: keyHash(known.receiver),
    senderSealed: seal(known.sender, known.owner),
    receiverSealed: seal(known.receiver, known.sender),
  };
  const channel = register(
    app,
    { keys, file, createdAt: now, lastTouched: now, completedTransfers: 0, clientQuotaId, hostBound },
    known,
  );
  persist(app, channel);
  return channel;
}
export function unnamed(channel: Channel) {
  return channel.file.filename === UNNAMED_FILE;
}
export function closeChannel(app: App, channel: Channel, cause: CloseReason | "capacity") {
  if (channel.closed) return;
  const reason: CloseReason = cause === "capacity" ? "expired" : cause;
  const error = closeMessages[reason];
  channel.closed = true;
  clearTimeout(channel.hostTimer);
  clearTimeout(channel.leaseTimer);
  channel.upload?.abort.abort(new HttpError(410, error, reason));
  for (const receiver of [...channel.waiting]) failReceiver(app, receiver, new Error(error), reason, 410);
  for (const subscriber of [...channel.subscribers]) {
    subscriber.sse.send("closed", { error, reason });
    subscriber.sse.finish();
  }
  for (const [tracker, trackedRoles] of channel.trackers)
    for (const role of trackedRoles.keys()) {
      if (!tracker.native) stationStatus(channel, tracker, role);
      tracker.sse.send("closed", { id: keyFor(channel, role), key: stationKey(channel, role), error, reason });
      tracker.subscriptions.delete(keyFor(channel, role));
    }
  channel.trackers.clear();
  app.channels.delete(channel.keys.owner);
  if (channel.clientQuotaId) {
    const remaining = (app.clientChannelCounts.get(channel.clientQuotaId) ?? 1) - 1;
    if (remaining) app.clientChannelCounts.set(channel.clientQuotaId, remaining);
    else app.clientChannelCounts.delete(channel.clientQuotaId);
  }
  for (const role of roles) app.capabilities.delete(channel.keys[role]);
  rememberClosed(app, channel, reason);
  if (!app.storeClosed) forget(app, channel.keys.owner);
}
