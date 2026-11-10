import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { keyHash, seal } from "./capability-keys";

export type FileDetails = { filename: string; contentType: string; contentLength?: number };
/**
 * A share's capability material at rest: SHA-256 hashes of the owner, sender and receiver keys, the sender key
 * sealed under the owner key and the receiver key sealed under the sender key. Raw keys never reach SQLite.
 */
export type StoredKeys = {
  owner: string;
  sender: string;
  receiver: string;
  senderSealed: string;
  receiverSealed: string;
};
export type ChannelMetadata = {
  keys: StoredKeys;
  file: FileDetails;
  createdAt: number;
  lastTouched: number;
  completedTransfers: number;
  usedAt?: number;
  lastProtectedAt?: number;
  clientQuotaId?: string;
  hostBound: boolean;
};

type ShareRow = {
  owner_hash: string;
  sender_hash: string;
  receiver_hash: string;
  sender_sealed: string;
  receiver_sealed: string;
  file_json: string;
  created_at: number;
  last_touched: number;
  completed_transfers: number;
  used_at: number | null;
  protected_at: number | null;
  client_quota_id: string | null;
  host_bound: number;
};

/** PRAGMA user_version while converted raw keys may still sit in free pages or the WAL. */
const SCRUB_PENDING = 1;
/** PRAGMA user_version once the file has been rewritten with no raw key left in it. */
const SCRUBBED = 2;

/** Only metadata enters SQLite. Upload streams never reach this module. */
export class MetadataStore {
  private readonly db: Database;
  private readonly saveStatement: ReturnType<Database["query"]>;
  private readonly deleteStatement: ReturnType<Database["query"]>;
  constructor(dataDir: string) {
    if (dataDir !== ":memory:") mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(dataDir === ":memory:" ? ":memory:" : join(dataDir, "channels.sqlite"), {
      create: true,
      strict: true,
    });
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS shares (owner_hash TEXT PRIMARY KEY, sender_hash TEXT NOT NULL UNIQUE, receiver_hash TEXT NOT NULL UNIQUE,
        sender_sealed TEXT NOT NULL, receiver_sealed TEXT NOT NULL, file_json TEXT NOT NULL, created_at INTEGER NOT NULL, last_touched INTEGER NOT NULL,
        completed_transfers INTEGER NOT NULL DEFAULT 0, used_at INTEGER, protected_at INTEGER, client_quota_id TEXT, host_bound INTEGER NOT NULL DEFAULT 0);`);
    this.saveStatement =
      this.db.query(`INSERT INTO shares (owner_hash, sender_hash, receiver_hash, sender_sealed, receiver_sealed, file_json,
      created_at, last_touched, completed_transfers, used_at, protected_at, client_quota_id, host_bound)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_hash) DO UPDATE SET file_json=excluded.file_json,
      last_touched=excluded.last_touched, completed_transfers=excluded.completed_transfers, used_at=excluded.used_at, protected_at=excluded.protected_at`);
    this.deleteStatement = this.db.query("DELETE FROM shares WHERE owner_hash = ?");
    this.migrateRawKeys();
  }
  /** Releases before hashed keys kept raw keys in a `channels` table; convert it once and scrub the file. */
  private migrateRawKeys() {
    if (this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channels'").get())
      this.convertRawKeys();
    // Releases before the marker left user_version 0 even when their scrub failed, with raw keys in free pages. Pages
    // reused since may keep old bytes in their unused space, which freelist_count doesn't show, so every unmarked
    // database is rewritten once; the store holds only share metadata, so that is cheap. A new database ends marked too.
    if ((this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version !== SCRUBBED)
      this.scrub();
  }
  private convertRawKeys() {
    const convert = this.db.transaction(() => {
      const rows = this.db.query("SELECT * FROM channels").all() as Array<Record<string, string | number | null>>;
      for (const row of rows) {
        const [owner, sender, receiver] = [String(row.id), String(row.sender_key), String(row.receiver_key)];
        const completed = Number(row.completed_transfers ?? 0);
        this.save({
          keys: {
            owner: keyHash(owner),
            sender: keyHash(sender),
            receiver: keyHash(receiver),
            senderSealed: seal(sender, owner),
            receiverSealed: seal(receiver, sender),
          },
          file: JSON.parse(String(row.file_json)),
          createdAt: Number(row.created_at),
          lastTouched: Number(row.last_touched),
          completedTransfers: completed,
          usedAt: row.used_at != null ? Number(row.used_at) : completed > 0 ? Number(row.last_touched) : undefined,
          lastProtectedAt: row.protected_at != null ? Number(row.protected_at) : undefined,
          clientQuotaId: row.client_quota_id != null ? String(row.client_quota_id) : undefined,
          hostBound: row.host_bound === 1,
        });
      }
      this.db.exec("DROP TABLE channels");
      // Committed with the conversion, so a scrub that a crash or a full disk cuts short runs again on the next start.
      this.db.exec(`PRAGMA user_version = ${SCRUB_PENDING}`);
    });
    const { secure_delete: secureDelete } = this.db.query("PRAGMA secure_delete").get() as { secure_delete: number };
    // Zeroes the dropped table's pages as they are freed, so even before VACUUM they hold no raw key.
    this.db.exec("PRAGMA secure_delete = ON");
    try {
      convert();
    } finally {
      this.db.exec(`PRAGMA secure_delete = ${secureDelete}`);
    }
  }
  /** Rewrites the file and empties the WAL so no freed page or old WAL frame still holds a raw key. */
  private scrub() {
    try {
      this.db.exec("VACUUM");
      const { busy } = this.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (busy !== 0) throw new Error("another connection still reads the old pages");
      this.db.exec(`PRAGMA user_version = ${SCRUBBED}`);
    } catch (error) {
      console.warn(
        `Raw share keys from an earlier release may remain in the data directory (${error instanceof Error ? error.message : error}); ` +
          "the scrub runs again on the next start.",
      );
    }
  }
  load(since: number, limit: number): ChannelMetadata[] {
    this.db.query("DELETE FROM shares WHERE last_touched < ?").run(since);
    const rows = this.db.query("SELECT * FROM shares ORDER BY last_touched DESC LIMIT ?").all(limit) as ShareRow[];
    this.db
      .query(
        "DELETE FROM shares WHERE owner_hash NOT IN (SELECT owner_hash FROM shares ORDER BY last_touched DESC LIMIT ?)",
      )
      .run(limit);
    return rows.map((row) => ({
      keys: {
        owner: row.owner_hash,
        sender: row.sender_hash,
        receiver: row.receiver_hash,
        senderSealed: row.sender_sealed,
        receiverSealed: row.receiver_sealed,
      },
      file: JSON.parse(row.file_json),
      createdAt: row.created_at,
      lastTouched: row.last_touched,
      completedTransfers: row.completed_transfers,
      usedAt: row.used_at ?? undefined,
      lastProtectedAt: row.protected_at ?? undefined,
      clientQuotaId: row.client_quota_id ?? undefined,
      hostBound: row.host_bound === 1,
    }));
  }
  save(channel: ChannelMetadata) {
    const { keys } = channel;
    this.saveStatement.run(
      keys.owner,
      keys.sender,
      keys.receiver,
      keys.senderSealed,
      keys.receiverSealed,
      JSON.stringify(channel.file),
      channel.createdAt,
      channel.lastTouched,
      channel.completedTransfers,
      channel.usedAt ?? null,
      channel.lastProtectedAt ?? null,
      channel.clientQuotaId ?? null,
      channel.hostBound ? 1 : 0,
    );
  }
  delete(ownerHash: string) {
    this.deleteStatement.run(ownerHash);
  }
  close() {
    this.db.close();
  }
}
