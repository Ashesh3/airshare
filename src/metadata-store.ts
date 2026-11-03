import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type FileDetails = { filename: string; contentType: string; contentLength?: number };
export type ChannelMetadata = { id: string; senderKey: string; receiverKey: string; file: FileDetails; createdAt: number; lastTouched: number; completedTransfers: number; usedAt?: number; lastProtectedAt?: number; clientQuotaId?: string };

/** Only metadata enters SQLite. Upload streams never reach this module. */
export class MetadataStore {
  private readonly db: Database;
  private readonly saveStatement: ReturnType<Database["query"]>;
  private readonly deleteStatement: ReturnType<Database["query"]>;
  constructor(dataDir: string) {
    if (dataDir !== ":memory:") mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(dataDir === ":memory:" ? ":memory:" : join(dataDir, "channels.sqlite"), { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, sender_key TEXT NOT NULL UNIQUE,
        receiver_key TEXT NOT NULL UNIQUE, file_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        last_touched INTEGER NOT NULL, completed_transfers INTEGER NOT NULL DEFAULT 0, used_at INTEGER, protected_at INTEGER, client_quota_id TEXT);`);
    const columns = this.db.query("PRAGMA table_info(channels)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "used_at")) this.db.exec("ALTER TABLE channels ADD COLUMN used_at INTEGER");
    if (!columns.some((column) => column.name === "protected_at")) this.db.exec("ALTER TABLE channels ADD COLUMN protected_at INTEGER");
    if (!columns.some((column) => column.name === "client_quota_id")) this.db.exec("ALTER TABLE channels ADD COLUMN client_quota_id TEXT");
    this.db.exec("UPDATE channels SET used_at=last_touched WHERE used_at IS NULL AND completed_transfers > 0");
    this.saveStatement = this.db.query(`INSERT INTO channels (id, sender_key, receiver_key, file_json, created_at, last_touched, completed_transfers, used_at, protected_at, client_quota_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET file_json=excluded.file_json,
      last_touched=excluded.last_touched, completed_transfers=excluded.completed_transfers, used_at=excluded.used_at, protected_at=excluded.protected_at`);
    this.deleteStatement = this.db.query("DELETE FROM channels WHERE id = ?");
  }
  load(since: number, limit: number): ChannelMetadata[] {
    this.db.query("DELETE FROM channels WHERE last_touched < ?").run(since);
    const rows = this.db.query("SELECT * FROM channels ORDER BY last_touched DESC LIMIT ?").all(limit) as Array<{
      id: string; sender_key: string; receiver_key: string; file_json: string; created_at: number; last_touched: number; completed_transfers: number; used_at: number | null; protected_at: number | null; client_quota_id: string | null;
    }>;
    this.db.query("DELETE FROM channels WHERE id NOT IN (SELECT id FROM channels ORDER BY last_touched DESC LIMIT ?)").run(limit);
    return rows.map((row) => ({ id: row.id, senderKey: row.sender_key, receiverKey: row.receiver_key,
      file: JSON.parse(row.file_json), createdAt: row.created_at, lastTouched: row.last_touched, completedTransfers: row.completed_transfers, usedAt: row.used_at ?? undefined, lastProtectedAt: row.protected_at ?? undefined, clientQuotaId: row.client_quota_id ?? undefined }));
  }
  save(channel: ChannelMetadata) {
    this.saveStatement.run(channel.id, channel.senderKey, channel.receiverKey, JSON.stringify(channel.file), channel.createdAt, channel.lastTouched, channel.completedTransfers, channel.usedAt ?? null, channel.lastProtectedAt ?? null, channel.clientQuotaId ?? null);
  }
  delete(id: string) { this.deleteStatement.run(id); }
  close() { this.db.close(); }
}
