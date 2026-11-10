import { afterEach, expect, spyOn, test } from "bun:test";
import { createApp } from "../src/app";
import { createChannel } from "../src/channels";
import { loadConfig } from "../src/config";
import type { App } from "../src/context";
import { fileDetails } from "../src/filenames";
import { download, handleUpload } from "../src/relay";
import { until } from "./server-helper";

const base = "http://relay.test";
const apps: App[] = [];
function relay(env: Record<string, string> = {}) {
  const app = createApp(loadConfig({ DATA_DIR: ":memory:", ...env }));
  apps.push(app);
  return app;
}
afterEach(() => {
  for (const app of apps.splice(0)) {
    app.storeClosed = true;
    app.store.close();
  }
});
const share = (app: App) =>
  createChannel(app, new Request(`${base}/api/channels`, { method: "POST" }), fileDetails({ filename: "drain.bin" }));
const uploadRequest = (body: string, signal?: AbortSignal) =>
  new Request(`${base}/u/key/drain.bin`, { method: "PUT", body, headers: { "x-airshare-no-redirect": "1" }, signal });

test("an uploader that hangs up once its whole body has arrived leaves its receivers to finish", async () => {
  const app = relay();
  const channel = share(app);
  const receiving = download(app, new Request(`${base}/l/key`), channel, {});
  const uploader = new AbortController();
  const uploading = handleUpload(app, uploadRequest("every byte arrived", uploader.signal), channel, {});
  const response = await receiving;
  // The receiver hasn't read yet, so once every byte is in the relay waits for it to drain.
  await until(
    async () => channel.upload?.bytes,
    (bytes) => bytes === "every byte arrived".length,
  );
  await Bun.sleep(20);
  uploader.abort();
  await Bun.sleep(20);
  expect(await response.text()).toBe("every byte arrived");
  expect((await uploading).status).toBe(200);
  expect(channel.completedTransfers).toBe(1);
  expect(channel.lastUpload).toMatchObject({ reason: "completed" });
});

test("an uploader that hangs up before its body ends still cuts its receivers", async () => {
  const app = relay();
  const channel = share(app);
  const receiving = download(app, new Request(`${base}/l/key`), channel, {});
  const uploader = new AbortController();
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      input = controller;
    },
  });
  const request = new Request(`${base}/u/key/drain.bin`, {
    method: "PUT",
    body,
    headers: { "x-airshare-no-redirect": "1" },
    signal: uploader.signal,
  });
  const uploading = handleUpload(app, request, channel, {});
  input.enqueue(new TextEncoder().encode("partial"));
  const response = await receiving;
  uploader.abort();
  await expect(response.text()).rejects.toThrow();
  expect((await uploading).status).toBe(499);
  expect(channel.completedTransfers).toBe(0);
});
test("a save that fails as an upload starts still releases the client's upload slot", async () => {
  const app = relay({ MAX_UPLOADS_PER_CLIENT: "1" });
  const channel = share(app);
  const save = app.store.save;
  const errors = spyOn(console, "error").mockImplementation(() => {});
  app.store.save = () => {
    throw new Error("database or disk is full");
  };
  try {
    await handleUpload(app, uploadRequest("never stored"), channel, {});
  } catch {
    /* the failed save may surface either way */
  }
  app.store.save = save;
  errors.mockRestore();
  expect(channel.upload).toBeUndefined();
  const release = app.admission.leaseClient(uploadRequest("next"), "upload");
  expect(release).toBeFunction();
  release?.();
});

test("a save that keeps failing as a started upload finishes still detaches the upload and answers the uploader", async () => {
  const app = relay({ MAX_UPLOADS_PER_CLIENT: "1" });
  const channel = share(app);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const save = app.store.save;
  try {
    const receiving = download(app, new Request(`${base}/l/key`), channel, {});
    const uploading = handleUpload(app, uploadRequest("saved nowhere"), channel, {});
    const response = await receiving;
    // From here every save fails (a full disk), and with a stale save time every touch attempts one.
    app.store.save = () => {
      throw new Error("database or disk is full");
    };
    channel.lastPersisted = 0;
    expect(await response.text()).toBe("saved nowhere");
    const answer = await uploading;
    expect(answer.status).toBe(200);
    expect(channel.upload).toBeUndefined();
    expect(channel.lastUpload).toMatchObject({ reason: "completed" });
    expect(errors).toHaveBeenCalled();
    app.store.save = save;
    // The share isn't left busy, and the client's one upload slot is free again.
    const next = download(app, new Request(`${base}/l/key`), channel, {});
    const nextUpload = handleUpload(app, uploadRequest("next transfer"), channel, {});
    expect(await (await next).text()).toBe("next transfer");
    expect((await nextUpload).status).toBe(200);
  } finally {
    app.store.save = save;
    errors.mockRestore();
  }
});

test("a save that fails as a download arrives leaves no receiver registered or leased", async () => {
  const app = relay({ MAX_RECEIVERS_PER_CLIENT: "1" });
  const channel = share(app);
  const save = app.store.save;
  app.store.save = () => {
    throw new Error("database or disk is full");
  };
  channel.lastPersisted = 0;
  try {
    expect(() => download(app, new Request(`${base}/l/key`), channel, {})).toThrow("database or disk is full");
  } finally {
    app.store.save = save;
  }
  expect(channel.waiting.size).toBe(0);
  expect(app.receiverCount).toBe(0);
  // The client's only receiver slot is free, so the next download waits instead of getting 429.
  const receiving = download(app, new Request(`${base}/l/key`), channel, {});
  expect(channel.waiting.size).toBe(1);
  const uploading = handleUpload(app, uploadRequest("after the full disk"), channel, {});
  expect(await (await receiving).text()).toBe("after the full disk");
  expect((await uploading).status).toBe(200);
});
