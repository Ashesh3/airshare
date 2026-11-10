import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { keyHash } from "../src/capability-keys";
import { MetadataStore } from "../src/metadata-store";
import { rawKeysIn, temporaryDataDir } from "./server-helper";

const legacy = { id: "a".repeat(32), senderKey: "b".repeat(32), receiverKey: "c".repeat(32) };
/** A data directory from a release that kept raw keys, in the oldest schema. */
function writeLegacyStore(dir: string) {
  const db = new Database(join(dir, "channels.sqlite"), { create: true });
  db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE channels (id TEXT PRIMARY KEY, sender_key TEXT NOT NULL UNIQUE, receiver_key TEXT NOT NULL UNIQUE,
    file_json TEXT NOT NULL, created_at INTEGER NOT NULL, last_touched INTEGER NOT NULL, completed_transfers INTEGER NOT NULL DEFAULT 0)`);
  const file = JSON.stringify({ filename: "legacy.txt", contentType: "text/plain", contentLength: 6 });
  db.query("INSERT INTO channels VALUES (?, ?, ?, ?, ?, ?, 0)").run(
    legacy.id,
    legacy.senderKey,
    legacy.receiverKey,
    file,
    Date.now(),
    Date.now(),
  );
  db.close();
}
function userVersion(dir: string) {
  const db = new Database(join(dir, "channels.sqlite"));
  try {
    return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}
/** 2 marks a database rewritten with no raw key left in it. */
const scrubPending = (dir: string) => userVersion(dir) !== 2;

test("a raw-key scrub cut short by a failed VACUUM and a crash runs again on the next start", async () => {
  const dir = await temporaryDataDir();
  try {
    writeLegacyStore(dir.path);
    const store = pathToFileURL(join(import.meta.dir, "../src/metadata-store.ts")).href;
    // The first start converts the keys, its VACUUM fails as on a full disk, and the process dies before closing the database.
    const firstStart = `
      const { Database } = await import("bun:sqlite");
      const exec = Database.prototype.exec;
      Database.prototype.exec = function (sql, ...rest) { if (sql === "VACUUM") throw new Error("database or disk is full"); return exec.call(this, sql, ...rest); };
      const { MetadataStore } = await import(${JSON.stringify(store)});
      globalThis.store = new MetadataStore(${JSON.stringify(dir.path)});
      console.log("converted");
      setInterval(() => {}, 1000);`;
    const child = Bun.spawn([process.execPath, "-e", firstStart], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("converted")) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`First start ended early: ${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(value);
    }
    child.kill("SIGKILL");
    await child.exited;
    expect(await new Response(child.stderr).text()).toContain("the scrub runs again on the next start");
    expect((await rawKeysIn(dir.path, Object.values(legacy))).length).toBeGreaterThan(0);

    const restarted = new MetadataStore(dir.path);
    expect(restarted.load(0, 10).map((share) => share.keys.owner)).toEqual([keyHash(legacy.id)]);
    restarted.close();
    expect(scrubPending(dir.path)).toBe(false);
    expect(await rawKeysIn(dir.path, Object.values(legacy))).toEqual([]);
  } finally {
    await dir.remove();
  }
});

test("the scrub stays pending while another connection still reads the old pages", async () => {
  const dir = await temporaryDataDir();
  try {
    writeLegacyStore(dir.path);
    const reader = new Database(join(dir.path, "channels.sqlite"));
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM channels").get();
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      new MetadataStore(dir.path).close();
    } finally {
      console.warn = warn;
    }
    expect(warnings.join("\n")).toContain("the scrub runs again on the next start");
    reader.exec("COMMIT");
    reader.close();
    expect(scrubPending(dir.path)).toBe(true);
    new MetadataStore(dir.path).close();
    expect(scrubPending(dir.path)).toBe(false);
    expect(await rawKeysIn(dir.path, Object.values(legacy))).toEqual([]);
  } finally {
    await dir.remove();
  }
});

test("a database an earlier release converted without finishing its scrub is scrubbed once on the next start", async () => {
  const dir = await temporaryDataDir();
  const exec = spyOn(Database.prototype, "exec");
  try {
    // What such a release left behind: the raw-key table dropped without secure_delete or a successful VACUUM, and no marker.
    writeLegacyStore(dir.path);
    const db = new Database(join(dir.path, "channels.sqlite"));
    db.exec("PRAGMA secure_delete = OFF; DROP TABLE channels");
    db.close();
    expect(userVersion(dir.path)).toBe(0);
    expect((await rawKeysIn(dir.path, Object.values(legacy))).length).toBeGreaterThan(0);
    new MetadataStore(dir.path).close();
    expect(userVersion(dir.path)).toBe(2);
    expect(await rawKeysIn(dir.path, Object.values(legacy))).toEqual([]);
    // Once marked, later starts don't rewrite the file again.
    exec.mockClear();
    new MetadataStore(dir.path).close();
    expect(exec.mock.calls.filter(([sql]) => sql === "VACUUM")).toEqual([]);
  } finally {
    exec.mockRestore();
    await dir.remove();
  }
});

test("a new database starts with the scrubbed marker", async () => {
  const dir = await temporaryDataDir();
  try {
    new MetadataStore(dir.path).close();
    expect(userVersion(dir.path)).toBe(2);
  } finally {
    await dir.remove();
  }
});
