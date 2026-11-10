import type { Admission } from "./admission";
import type { Config } from "./config";
import type { ChannelMetadata, FileDetails, MetadataStore } from "./metadata-store";
import type { TransferHash } from "./transfer-hash";

export type Role = "owner" | "sender" | "receiver";
export const roles = ["owner", "sender", "receiver"] as const;
export type CloseReason = "sender_left" | "deleted" | "expired";
export const closeMessages: Record<CloseReason, string> = {
  sender_left: "The sender stopped sharing this file.",
  deleted: "This share was deleted.",
  expired: "This share expired.",
};
export type Capability = { channel: Channel; role: Role };
export type TransferOptions = { trackerKey?: string; transferTag?: string };
export type Sse = { send: (event: string, data: unknown) => boolean; finish: () => void; response: Response };
export type NativeSubscriber = { role: Role; origin: string; hosting: boolean; sse: Sse };
/** Native trackers carry AirShare status payloads; Station trackers keep the Station event format. */
export type Tracker = { id: string; sse: Sse; subscriptions: Map<string, Capability>; origin: string; native: boolean };
export type Receiver = TransferOptions & {
  channel: Channel;
  stream: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  respond: (response: Response) => void;
  responded: boolean;
  closed: boolean;
  bytesWritten: number;
  /** Set while the receiver's queue is full: resumes the transfer, or fails it once the stall watchdog gives up. */
  wake?: () => void;
  stall?: (error: Error) => void;
  blockedSince?: number;
  cleanup: () => void;
  clientRelease: () => void;
  upload?: Upload;
};
export type Upload = TransferOptions & {
  metadata: Readonly<FileDetails>;
  abort: AbortController;
  signal: AbortSignal;
  receivers: Set<Receiver>;
  reader?: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock">;
  started: boolean;
  bytes: number;
  successful: number;
  lastProgress: number;
  uploadId: string;
  /** Set once the whole body has arrived: from then on the uploader leaving no longer cuts its receivers. */
  complete: boolean;
  /** Present only for uploads that asked for a hash (Station no-redirect, a Station-format tracker, or x-airshare-hash: 1). */
  hasher?: TransferHash;
  hash?: string;
  maxReceived: number;
};
export type Channel = ChannelMetadata & {
  /** Raw keys live only in memory. After a restart a role's key is learned when its holder presents it. */
  known: Partial<Record<Role, string>>;
  /** Each tracker's subscribed roles, mapped to whether that subscription is a host signal. */
  waiting: Set<Receiver>;
  subscribers: Set<NativeSubscriber>;
  trackers: Map<Tracker, Map<Role, boolean>>;
  upload?: Upload;
  wakeUploader?: () => void;
  closed: boolean;
  lastPersisted: number;
  lastError?: string;
  senderLeaseUntil: number;
  lastUpload?: { id: string; reason: string; retryable: boolean; error?: string };
  creating: boolean;
  /** Host signals are volatile: a hosting stream, a sender/channel tracker, an unexpired presence lease or an upload. */
  hostOnline: boolean;
  lastHostSeenAt: number;
  hostTimer?: ReturnType<typeof setTimeout>;
  leaseTimer?: ReturnType<typeof setTimeout>;
  announcedOnline: boolean;
};
/** One relay's state. Every module function takes it, so several relays can run in one process. */
export type App = {
  config: Config;
  store: MetadataStore;
  admission: Admission;
  channels: Map<string, Channel>;
  capabilities: Map<string, Capability>;
  trackers: Map<string, Tracker>;
  clientChannelCounts: Map<string, number>;
  closedKeys: Map<string, { reason: CloseReason; role: Role; at: number }>;
  receiverCount: number;
  subscriberCount: number;
  stopping: boolean;
  storeClosed: boolean;
  /** Owner hashes of closed shares whose rows a failed delete left behind; each cleanup sweep retries them. */
  pendingDeletes: Set<string>;
  blockedReceivers: Set<Receiver>;
  stallWatchdog?: ReturnType<typeof setInterval>;
};
