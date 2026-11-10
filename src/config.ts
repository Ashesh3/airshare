type Env = Record<string, string | undefined>;
function reader(env: Env) {
  const integer = (name: string, fallback: number, minimum = 1): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
    return value;
  };
  const toggle = (name: string, fallback: boolean): boolean => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (raw === "on") return true;
    if (raw === "off") return false;
    throw new Error(`${name} must be on or off`);
  };
  return { integer, toggle };
}
function publicOrigin(env: Env): string | undefined {
  if (!env.PUBLIC_URL) return;
  const url = new URL(env.PUBLIC_URL);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("PUBLIC_URL must be an http(s) origin, without credentials, path, query or fragment");
  }
  return url.origin;
}
/** Reads the relay's settings from environment variables; createServer takes the result. */
export function loadConfig(env: Env = Bun.env) {
  const { integer, toggle } = reader(env);
  return {
    port: integer("PORT", 3070, 0),
    hostname: env.HOST ?? "0.0.0.0",
    publicOrigin: publicOrigin(env),
    dataDir: env.DATA_DIR ?? "./data",
    channelTtl: integer("CHANNEL_TTL_MS", 86_400_000),
    cleanupInterval: integer("CLEANUP_INTERVAL_MS", 60_000),
    maxChannels: integer("MAX_CHANNELS", 10_000),
    maxReceiversPerChannel: integer("MAX_RECEIVERS_PER_CHANNEL", 64),
    maxReceivers: integer("MAX_RECEIVERS", 4096),
    maxSubscribersPerChannel: integer("MAX_SUBSCRIBERS_PER_CHANNEL", 64),
    maxSubscribers: integer("MAX_SUBSCRIBERS", 4096),
    maxTrackerChannels: integer("MAX_TRACKER_CHANNELS", 256),
    maxPresenceKeys: integer("MAX_PRESENCE_KEYS", 256),
    maxRequestBodySize: integer("MAX_REQUEST_BODY_SIZE", Number.MAX_SAFE_INTEGER),
    maxMetadataBytes: integer("MAX_METADATA_BYTES", 16_384),
    controlBodyTimeout: integer("CONTROL_BODY_TIMEOUT_MS", 10_000),
    streamHighWaterMark: integer("STREAM_HIGH_WATER_MARK", 65_536),
    receiverStallTimeout: integer("RECEIVER_STALL_TIMEOUT_MS", 120_000),
    receiverFirstByteTimeout: integer("RECEIVER_FIRST_BYTE_TIMEOUT_MS", 15_000),
    unusedChannelTtl: integer("UNUSED_CHANNEL_TTL_MS", 3_600_000),
    hostGrace: integer("HOST_GRACE_MS", 20_000),
    senderLease: integer("SENDER_LEASE_MS", 10_000),
    creationBurst: integer("CHANNEL_CREATION_BURST", 30, 0),
    creationInterval: integer("CHANNEL_CREATION_INTERVAL_MS", 60_000),
    maxCreationBuckets: integer("MAX_CREATION_BUCKETS", 4096),
    trustedProxies: env.TRUSTED_PROXIES ?? "",
    maxReceiversPerClient: integer("MAX_RECEIVERS_PER_CLIENT", 128),
    maxSubscribersPerClient: integer("MAX_SUBSCRIBERS_PER_CLIENT", 64),
    maxUploadsPerClient: integer("MAX_UPLOADS_PER_CLIENT", 32),
    maxDiscards: integer("MAX_DISCARDS", 64),
    maxDiscardsPerClient: integer("MAX_DISCARDS_PER_CLIENT", 8),
    maxChannelsPerClient: integer("MAX_CHANNELS_PER_CLIENT", 256, 0),
    transferHash: toggle("TRANSFER_HASH", true),
    // 103 probes are the only way to see that a waiting sender's client is gone: its FIN sits behind the unread body.
    livenessHints: toggle("LIVENESS_HINTS", true),
  };
}
export type Config = ReturnType<typeof loadConfig>;
export const config = loadConfig();
