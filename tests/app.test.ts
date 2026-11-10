import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "../src/app";
import { keyHash } from "../src/capability-keys";
import { loadConfig } from "../src/config";
import { MetadataStore } from "../src/metadata-store";
import { temporaryDataDir, until } from "./server-helper";

const testConfig = (env: Record<string, string> = {}) =>
  loadConfig({ HOST: "127.0.0.1", PORT: "0", DATA_DIR: ":memory:", ...env });
const createShare = async (base: string) => {
  const response = await fetch(`${base}/api/channels`, {
    method: "POST",
    body: JSON.stringify({ filename: "in-process.txt" }),
    headers: { "content-type": "application/json" },
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; statusUrl: string; uploadUrl: string; downloadUrl: string }>;
};

const receiverWaiting = (statusUrl: string) =>
  until(
    () => fetch(statusUrl).then((response) => response.json() as Promise<{ waitingReceivers: number }>),
    (value) => value.waitingReceivers === 1,
  );

describe("createServer", () => {
  test("a relay that can't listen closes its database and stops its timers", async () => {
    const taken = await createServer(testConfig());
    const data = await temporaryDataDir();
    const close = spyOn(MetadataStore.prototype, "close");
    const intervals = spyOn(globalThis, "setInterval");
    const cleared = spyOn(globalThis, "clearInterval");
    try {
      await expect(createServer(testConfig({ DATA_DIR: data.path, PORT: String(taken.port) }))).rejects.toThrow();
      expect(close).toHaveBeenCalledTimes(1);
      expect(intervals).toHaveBeenCalled();
      for (const { value } of intervals.mock.results) expect(cleared).toHaveBeenCalledWith(value);
    } finally {
      close.mockRestore();
      intervals.mockRestore();
      cleared.mockRestore();
      await taken.shutdown();
      await data.remove();
    }
  });
  test("runs independent relays in one process", async () => {
    const [first, second] = await Promise.all([createServer(testConfig()), createServer(testConfig())]);
    try {
      expect(first.port).not.toBe(second.port);
      const share = await createShare(`http://127.0.0.1:${first.port}`);
      expect((await fetch(`http://127.0.0.1:${second.port}/api/channels/${share.id}`)).status).toBe(404);
      const download = fetch(share.downloadUrl);
      await receiverWaiting(share.statusUrl);
      const upload = await fetch(share.uploadUrl, {
        method: "PUT",
        body: "hello in-process",
        headers: { "x-airshare-no-redirect": "1" },
      });
      expect(upload.status).toBe(200);
      expect(await (await download).text()).toBe("hello in-process");
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
    }
  });

  test("shutdown answers a waiting receiver, keeps other relays serving and saves shares for the next start", async () => {
    const data = await temporaryDataDir();
    const other = await createServer(testConfig());
    try {
      const relay = await createServer(testConfig({ DATA_DIR: data.path }));
      const share = await createShare(`http://127.0.0.1:${relay.port}`);
      const waiting = fetch(share.downloadUrl);
      await receiverWaiting(share.statusUrl);
      await relay.shutdown();
      const answer = await waiting;
      expect(answer.status).toBe(503);
      expect(((await answer.json()) as { reason: string }).reason).toBe("stopping");
      expect((await fetch(`http://127.0.0.1:${other.port}/healthz`)).status).toBe(200);
      const restarted = await createServer(testConfig({ DATA_DIR: data.path }));
      try {
        const status = await fetch(`http://127.0.0.1:${restarted.port}/api/channels/${share.id}`);
        expect(status.status).toBe(200);
        expect(((await status.json()) as { file: { filename: string } }).file.filename).toBe("in-process.txt");
      } finally {
        await restarted.shutdown();
      }
    } finally {
      await other.shutdown();
      await data.remove();
    }
  });
  test("shutdown answers waiting and attached receivers and their upload alike: 503 stopping with Retry-After", async () => {
    const relay = await createServer(testConfig());
    const base = `http://127.0.0.1:${relay.port}`;
    const [idle, busy] = [await createShare(base), await createShare(base)];
    const waiting = fetch(idle.downloadUrl);
    const attached = fetch(busy.downloadUrl);
    await receiverWaiting(idle.statusUrl);
    await receiverWaiting(busy.statusUrl);
    // The upload has taken the receiver but sent no byte, so the receiver has no answer yet.
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const uploading = fetch(busy.uploadUrl, { method: "PUT", body, headers: { "x-airshare-no-redirect": "1" } });
    const status = () =>
      fetch(busy.statusUrl).then((response) => response.json() as Promise<{ activeReceivers: number }>);
    await until(status, (value) => value.activeReceivers === 1);
    await relay.shutdown();
    for (const [name, pending] of [
      ["waiting", waiting],
      ["attached", attached],
      ["upload", uploading],
    ] as const) {
      const response = await pending;
      expect(response.status, name).toBe(503);
      expect(response.headers.get("retry-after"), name).toBe("5");
      expect(((await response.json()) as { reason: string }).reason, name).toBe("stopping");
    }
  });

  test("shutdown with a full disk still answers 503 stopping and completes", async () => {
    const relay = await createServer(testConfig());
    const share = await createShare(`http://127.0.0.1:${relay.port}`);
    const waiting = fetch(share.downloadUrl);
    await receiverWaiting(share.statusUrl);
    const save = spyOn(MetadataStore.prototype, "save").mockImplementation(() => {
      throw new Error("database or disk is full");
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await relay.shutdown();
      expect(save).toHaveBeenCalled();
      expect(errors).toHaveBeenCalled();
      const response = await waiting;
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(((await response.json()) as { reason: string }).reason).toBe("stopping");
      await expect(fetch(`http://127.0.0.1:${relay.port}/healthz`)).rejects.toThrow();
    } finally {
      save.mockRestore();
      errors.mockRestore();
    }
  });

  test("timers that hit a full disk log and retry, and the relay keeps serving", async () => {
    const data = await temporaryDataDir();
    // The host-grace timer closes the browser share well before the cleanup sweep, so each path meets the full disk.
    const relay = await createServer(
      testConfig({
        DATA_DIR: data.path,
        HOST_GRACE_MS: "300",
        CLEANUP_INTERVAL_MS: "600",
        UNUSED_CHANNEL_TTL_MS: "400",
      }),
    );
    const base = `http://127.0.0.1:${relay.port}`;
    const create = async (body: Record<string, unknown>) => {
      const response = await fetch(`${base}/api/channels`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      return response.json() as Promise<{ id: string; statusUrl: string; downloadUrl: string }>;
    };
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    // Each sweep saves this one as protected, since a receiver waits on it.
    const waited = await create({ filename: "waited.txt" });
    const waiting = fetch(waited.downloadUrl);
    await receiverWaiting(waited.statusUrl);
    // A browser share whose tab never connects, and a terminal share nobody uses.
    const abandoned = await create({ filename: "abandoned.txt", hostBound: true });
    const unused = await create({ filename: "unused.txt" });
    const full = () => {
      throw new Error("database or disk is full");
    };
    const save = spyOn(MetadataStore.prototype, "save").mockImplementation(full);
    const remove = spyOn(MetadataStore.prototype, "delete").mockImplementation(full);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await until(
        async () => remove.mock.calls.length,
        (calls) => calls >= 3,
        4000,
      );
      expect(save).toHaveBeenCalled();
      expect(uncaught).toEqual([]);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      for (const share of [abandoned, unused]) expect((await fetch(share.statusUrl)).status).toBe(410);
    } finally {
      save.mockRestore();
      remove.mockRestore();
      errors.mockRestore();
    }
    try {
      // With room on the disk again, a fresh transfer works, and the next sweep removes the closed shares' rows.
      const fresh = await createShare(base);
      const downloading = fetch(fresh.downloadUrl);
      await receiverWaiting(fresh.statusUrl);
      const upload = await fetch(fresh.uploadUrl, {
        method: "PUT",
        body: "after the full disk",
        headers: { "x-airshare-no-redirect": "1" },
      });
      expect(upload.status).toBe(200);
      expect(await (await downloading).text()).toBe("after the full disk");
      await Bun.sleep(700);
      await relay.shutdown();
      expect((await waiting).status).toBe(503);
      expect(uncaught).toEqual([]);
      const db = new Database(join(data.path, "channels.sqlite"));
      const owners = (db.query("SELECT owner_hash FROM shares").all() as Array<{ owner_hash: string }>).map(
        (row) => row.owner_hash,
      );
      db.close();
      expect(owners).toContain(keyHash(waited.id));
      expect(owners).not.toContain(keyHash(abandoned.id));
      expect(owners).not.toContain(keyHash(unused.id));
    } finally {
      process.off("uncaughtException", onUncaught);
      await relay.shutdown();
      await data.remove();
    }
  }, 15_000);

  test("the last relay in a process to stop ends the hash worker, so the process can exit on its own", async () => {
    const source = (name: string) => JSON.stringify(pathToFileURL(join(import.meta.dir, "../src", name)).href);
    const script = `
      const { createServer } = await import(${source("app.ts")});
      const { loadConfig } = await import(${source("config.ts")});
      const config = loadConfig({ HOST: "127.0.0.1", PORT: "0", DATA_DIR: ":memory:", TRANSFER_HASH: "on" });
      const relays = [await createServer(config), await createServer(config)];
      async function hashed(relay, payload, midway) {
        const base = "http://127.0.0.1:" + relay.port;
        const share = await (await fetch(base + "/api/channels", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
        const downloading = fetch(share.downloadUrl).then((response) => response.text());
        while ((await (await fetch(share.statusUrl)).json()).waitingReceivers !== 1) await Bun.sleep(10);
        let input;
        const body = new ReadableStream({ start(controller) { input = controller; } });
        const headers = { "x-airshare-no-redirect": "1", "x-airshare-hash": "1" };
        const uploading = fetch(share.uploadUrl, { method: "PUT", body, headers });
        input.enqueue(new TextEncoder().encode(payload.slice(0, 8)));
        await midway?.();
        input.enqueue(new TextEncoder().encode(payload.slice(8)));
        input.close();
        const result = await (await uploading).json();
        if (await downloading !== payload) throw new Error("the download doesn't match");
        return result.succeeded.hash;
      }
      console.log("first " + await hashed(relays[0], "starts the hash worker"));
      // The first relay stops while the second is hashing, which still needs the worker.
      console.log("second " + await hashed(relays[1], "hashed while the other relay stops", () => relays[0].shutdown()));
      await relays[1].shutdown();
      console.log("stopped");`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    let output = "";
    const deadline = Date.now() + 10_000;
    while (!output.includes("stopped") && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    const stoppedAt = Date.now();
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!exited) child.kill();
    const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
    expect(output, await new Response(child.stderr).text()).toContain(`first ${sha256("starts the hash worker")}`);
    expect(output).toContain(`second ${sha256("hashed while the other relay stops")}`);
    expect(output).toContain("stopped");
    expect(exited, `still running ${Date.now() - stoppedAt} ms after both relays stopped`).toBe(true);
  }, 20_000);
});
