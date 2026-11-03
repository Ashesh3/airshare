function integer(name: string, fallback: number, minimum = 1): number {
  const raw = Bun.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}
function publicOrigin(): string | undefined {
  if (!Bun.env.PUBLIC_URL) return;
  const url = new URL(Bun.env.PUBLIC_URL);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("PUBLIC_URL must be an http(s) origin, without credentials, path, query or fragment");
  return url.origin;
}
export const config = {
  port: integer("PORT", 3070, 0), hostname: Bun.env.HOST ?? "0.0.0.0", publicOrigin: publicOrigin(), dataDir: Bun.env.DATA_DIR ?? "./data",
  channelTtl: integer("CHANNEL_TTL_MS", 86_400_000), cleanupInterval: integer("CLEANUP_INTERVAL_MS", 60_000),
  maxChannels: integer("MAX_CHANNELS", 10_000), maxReceiversPerChannel: integer("MAX_RECEIVERS_PER_CHANNEL", 64), maxReceivers: integer("MAX_RECEIVERS", 4096),
  maxSubscribersPerChannel: integer("MAX_SUBSCRIBERS_PER_CHANNEL", 64), maxSubscribers: integer("MAX_SUBSCRIBERS", 4096), maxTrackerChannels: integer("MAX_TRACKER_CHANNELS", 256),
  maxRequestBodySize: integer("MAX_REQUEST_BODY_SIZE", Number.MAX_SAFE_INTEGER), maxMetadataBytes: integer("MAX_METADATA_BYTES", 16_384), streamHighWaterMark: integer("STREAM_HIGH_WATER_MARK", 65_536),
  receiverStallTimeout: integer("RECEIVER_STALL_TIMEOUT_MS", 120_000),
  unusedChannelTtl: integer("UNUSED_CHANNEL_TTL_MS", 300_000),
  creationBurst: integer("CHANNEL_CREATION_BURST", 30, 0), creationInterval: integer("CHANNEL_CREATION_INTERVAL_MS", 60_000),
  maxCreationBuckets: integer("MAX_CREATION_BUCKETS", 4096), trustedProxies: Bun.env.TRUSTED_PROXIES ?? "",
  maxReceiversPerClient: integer("MAX_RECEIVERS_PER_CLIENT", 128), maxSubscribersPerClient: integer("MAX_SUBSCRIBERS_PER_CLIENT", 64),
  maxDiscards: integer("MAX_DISCARDS", 64), maxDiscardsPerClient: integer("MAX_DISCARDS_PER_CLIENT", 8),
  maxChannelsPerClient: integer("MAX_CHANNELS_PER_CLIENT", 256, 0),
};
