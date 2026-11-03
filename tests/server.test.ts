import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { createChannel, channelStatus, sseReader, startServer, temporaryDataDir, until, type RunningServer } from "./server-helper";

const servers: RunningServer[] = [];
const controllers: AbortController[] = [];
async function server(env: Record<string, string> = {}) {
  const instance = await startServer(env);
  servers.push(instance);
  return instance;
}
function signal() {
  const controller = new AbortController();
  controllers.push(controller);
  return controller;
}
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(servers.splice(0).map((instance) => instance.close()));
});

describe("capabilities and input boundaries", () => {
  test("receiver URLs and events reveal no sender or owner capability", async () => {
    const app = await server();
    const owner = await createChannel(app, { filename: "private.txt" });
    const senderKey = new URL(owner.uploadUrl).pathname.split("/")[3];
    const receiverKey = new URL(owner.downloadUrl).pathname.split("/")[2];
    expect(senderKey).not.toBe(owner.id);
    expect(receiverKey).not.toBe(owner.id);
    expect(receiverKey).not.toBe(senderKey);
    const receiver = await fetch(`${app.base}/api/channels/${receiverKey}`).then((r) => r.json()) as any;
    expect(receiver.role).toBe("receiver");
    expect(receiver.id).toBe(receiverKey);
    expect(receiver.uploadUrl).toBeUndefined();
    expect(receiver.deleteUrl).toBeUndefined();
    const page = await fetch(owner.humanUrl).then((r) => r.text());
    expect(page).not.toContain(owner.id);
    expect(page).not.toContain(senderKey);
    const response = await fetch(receiver.eventsUrl, { signal: signal().signal });
    const events = sseReader(response);
    const event = await events.next("status");
    expect(event.data.id).toBe(receiverKey);
    expect(JSON.stringify(event.data)).not.toContain(senderKey);
    expect(JSON.stringify(event.data)).not.toContain(owner.id);
    await events.cancel();
    for (const [url, method] of [
      [`${app.base}/api/channels/${receiverKey}/upload/x`, "PUT"],
      [`${app.base}/api/channels/${receiverKey}`, "DELETE"],
      [`${app.base}/api/v1/channel/sender/${receiverKey}/upload/x`, "PUT"],
      [`${app.base}/api/v1/channel/${receiverKey}/subscribe/missing`, "POST"],
      [`${app.base}/send/${receiverKey}`, "GET"],
    ]) {
      const denied = await fetch(url!, { method, signal: AbortSignal.timeout(3000) });
      expect([403, 404]).toContain(denied.status);
    }
  });

  test("Station role references cannot be relabeled as an owner", async () => {
    const app = await server();
    const response = await fetch(`${app.base}/api/v1/channel`, { method: "POST", body: "{}" });
    const created = await response.json() as any;
    const wrong = await fetch(`${app.base}/api/v1/channel/${created.keys.receiver_key}/subscribe/missing`, { method: "POST" });
    expect([403, 404]).toContain(wrong.status);
  });

  test("invalid metadata is a controlled client error", async () => {
    const app = await server();
    for (const body of [null, [], 5, { filename: 12 }, { contentType: {} }, { contentType: "not a media type" }, { contentLength: -1 }, { contentLength: 0.5 }, { contentLength: "12" }, { contentType: "text/plain\r\nx-injected: yes" }]) {
      const response = await fetch(`${app.base}/api/channels`, { method: "POST", body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
    const oversized = await fetch(`${app.base}/api/channels`, { method: "POST", body: JSON.stringify({ filename: "x".repeat(20000) }) });
    expect(oversized.status).toBe(413);
    const malformedPath = await fetch(`${app.base}/recv/%ZZ`);
    expect(malformedPath.status).toBe(400);
  });

  test("Station metadata validation also rejects an explicit null file object", async () => {
    const app = await server();
    const response = await fetch(`${app.base}/api/v1/channel`, { method: "POST", body: '{"file_details":null}' });
    expect(response.status).toBe(400);
  });

  test("chunked JSON bodies are capped independently of transfer size limits", async () => {
    const app = await server({ MAX_METADATA_BYTES: "1024" });
    const input = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ filename: "x".repeat(2000) }))); controller.close(); } });
    const response = await fetch(`${app.base}/api/channels`, { method: "POST", body: input });
    expect(response.status).toBe(413);
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
  });

  test("encoded Windows separators cannot escape the static asset directory", async () => {
    const app = await server();
    for (const path of ["/..%5cpackage.json", "/%2e%2e%5csrc%5cserver.ts", "/%2e%2e%2fpackage.json", "/%2FC%3A%2FWindows%2Fwin.ini"]) {
      const response = await fetch(`${app.base}${path}`);
      expect(response.status).toBe(404);
    }
    expect((await fetch(`${app.base}/styles.css`)).status).toBe(200);
  });

  test("CLI content negotiation still serves existing static assets", async () => {
    const app = await server();
    const response = await fetch(`${app.base}/styles.css`, { headers: { "user-agent": "curl/8.21.0" }, redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
  });

  test("Station tracker subscriptions and transfer events stay role-specific", async () => {
    const app = await server();
    const tracking = sseReader(await fetch(`${app.base}/api/v1/track`, { signal: signal().signal }));
    const trackerKey = (await tracking.next("tracker_event")).data.initialized.tracker_key;
    const created = await fetch(`${app.base}/api/v1/channel`, {
      method: "POST", body: JSON.stringify({ file_details: { filename: "tracked.txt", content_length: 5 }, tracker: { tracker_key: trackerKey, tag: "created", perspective: "receiver" } }),
    });
    expect(created.status).toBe(200);
    const channel = await created.json() as any;
    const subscribed = (await tracking.next("tracker_event")).data.subscribed;
    expect(subscribed.key).toEqual({ receiver: channel.keys.receiver_key });
    expect(JSON.stringify(subscribed)).not.toContain(channel.keys.channel_key);
    expect(JSON.stringify(subscribed)).not.toContain(channel.keys.sender_key);
    const forbidden = await fetch(`${app.base}/api/v1/channel/${channel.keys.receiver_key}/subscribe/${trackerKey}`, { method: "POST" });
    expect(forbidden.status).toBe(404);
    const downloading = fetch(`${channel.urls.receiver_url}?tracker=${trackerKey}&tag=receiving`, { signal: signal().signal }).then((response) => response.text());
    await until(() => channelStatus(app, { id: channel.keys.channel_key }), (value) => value.waitingReceivers === 1);
    const uploading = fetch(channel.urls.sender_url, { method: "PUT", body: "hello", headers: { "com.station307.no-redirect": "true", "com.station307.tracker": trackerKey, "com.station307.tag": "sending" } });
    expect(await downloading).toBe("hello");
    expect((await uploading).status).toBe(200);
    const completed = new Set<string>();
    while (completed.size < 2) {
      const event = (await tracking.next("transfer_event")).data;
      if (event.succeeded) completed.add(event.succeeded.tag);
    }
    expect([...completed].sort()).toEqual(["receiving", "sending"]);
    await tracking.cancel();
  });

  test("PUBLIC_URL controls advertised links and health works without channel allocation", async () => {
    const app = await server({ PUBLIC_URL: "https://share.example.test" });
    const response = await fetch(`${app.base}/api/channels`, {
      method: "POST", body: "{}", headers: { "x-forwarded-host": "attacker.test", "x-forwarded-proto": "http" },
    });
    const channel = await response.json() as any;
    expect(channel.uploadUrl).toStartWith("https://share.example.test/");
    expect(channel.statusUrl).toStartWith("https://share.example.test/");
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
  });

  test("local QR generation rejects foreign origins and executable URLs", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const valid = await fetch(`${app.base}/api/qr?url=${encodeURIComponent(channel.humanUrl)}`);
    expect(valid.headers.get("content-type")).toContain("image/svg+xml");
    expect(await valid.text()).toContain("<svg");
    for (const value of ["https://elsewhere.test/r/secret", "javascript:alert(1)", "data:text/html,test", "not a URL", `${app.base}/${"x".repeat(2050)}`]) {
      expect((await fetch(`${app.base}/api/qr?url=${encodeURIComponent(value)}`)).status).toBe(400);
    }
  });

  test("Unicode and control characters in filenames produce safe attachment headers", async () => {
    const app = await server();
    const filename = "रिपोर्ट😀\u202e\u0001.pdf";
    const channel = await createChannel(app, { filename, contentLength: 4 });
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
    const uploading = fetch(channel.uploadUrl, { method: "PUT", body: "data", headers: { "x-airshare-no-redirect": "1" } });
    const response = await downloading;
    const disposition = response.headers.get("content-disposition")!;
    expect(disposition).toContain("filename*=UTF-8''%E0%A4%B0");
    expect(disposition).not.toContain("%E2%80%AE");
    expect(disposition).not.toMatch(/[\u0000-\u001f\u007f-\uffff]/);
    expect(await response.text()).toBe("data");
    expect((await uploading).status).toBe(204);
  });

  test("capability pages suppress referrers and framing", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const response = await fetch(channel.humanUrl);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("stream lifecycle", () => {
  test("Station trackers receive their compatibility heartbeat before the ten-second client deadline", async () => {
    const app = await server();
    const events = sseReader(await fetch(`${app.base}/api/v1/track`, { signal: AbortSignal.timeout(9000) }));
    expect((await events.next("tracker_event")).data.initialized).toBeDefined();
    expect(typeof (await events.next("tracker_event")).data.ping).toBe("number");
    await events.cancel();
  }, 10_000);

  test("receiver departure is retryable and finishes the abandoned upload response without draining its remainder", async () => {
    const app = await server();
    for (const browser of [true, false]) {
      const channel = await createChannel(app, { contentLength: 8 * 1024 * 1024 });
      const receiverController = signal();
      const downloading = fetch(channel.downloadUrl, { signal: receiverController.signal });
      await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
      const uploaderController = signal();
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65_536)); } });
      const uploading = fetch(channel.uploadUrl, {
        method: "PUT", body, redirect: "manual", signal: uploaderController.signal,
        headers: { "content-length": String(8 * 1024 * 1024), "x-airshare-upload-id": "cancelled-attempt", ...(browser ? { "x-airshare-no-redirect": "1" } : {}) },
      }).then(async (response) => ({ status: response.status, location: response.headers.get("location"), text: await response.text() })).catch(() => null);
      const reader = (await downloading).body!.getReader();
      await reader.read();
      receiverController.abort();
      const status = await until(() => channelStatus(app, channel), (value) => !value.activeUpload);
      expect(status.lastUploadId).toBe("cancelled-attempt");
      expect(status.lastUploadReason).toBe("no_receivers");
      expect(status.lastUploadRetryable).toBe(true);
      expect(status.lastError).toBeUndefined();
      const result = await Promise.race([uploading, Bun.sleep(1500).then(() => "timeout")]);
      expect(result).not.toBe("timeout");
      expect(result).not.toBeNull();
      if (result && typeof result !== "string") {
        expect(result.status).toBe(browser ? 409 : 307);
        if (browser) expect(JSON.parse(result.text)).toMatchObject({ reason: "no_receivers", retryable: true });
        else expect(result.location).toBe(channel.uploadUrl);
      }
      uploaderController.abort();
      const receiverKey = new URL(channel.downloadUrl).pathname.split("/")[2];
      const publicStatus = await fetch(`${app.base}/api/channels/${receiverKey}`).then((response) => response.json()) as any;
      expect(publicStatus.lastUploadId).toBeUndefined();
    }
  });

  test("stdin channels are prepared without replaying their non-rewindable request body", async () => {
    const app = await server();
    const unsafe = await fetch(`${app.base}/xfr/piped.txt`, {
      method: "PUT", body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("unprepared")); controller.close(); } }), redirect: "manual",
    });
    expect(unsafe.status).toBe(411);
    expect(unsafe.headers.get("x-airshare-download-url")).toBeNull();
    const prepared = await fetch(`${app.base}/xfr/piped.txt?prepare=1`, { method: "POST", redirect: "manual" });
    expect(prepared.status).toBe(201);
    const uploadUrl = (await prepared.text()).trim();
    expect(uploadUrl).toBe(prepared.headers.get("x-airshare-upload-url")!);
    const downloading = fetch(prepared.headers.get("x-airshare-download-url")!, { signal: signal().signal }).then((response) => response.text());
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("complete pipe")); controller.close(); } });
    const upload = await fetch(uploadUrl, { method: "PUT", body, redirect: "manual" });
    expect(upload.status).toBe(200);
    expect(await downloading).toBe("complete pipe");
  });

  test("CLI redirects and preparation have explicit finite response framing", async () => {
    const app = await server();
    const initial = await fetch(`${app.base}/xfr/framed.txt`, { method: "PUT", body: "hello", redirect: "manual" });
    expect(initial.status).toBe(307);
    expect(initial.headers.get("content-length")).toBe("0");
    expect(await initial.text()).toBe("");
    expect(initial.headers.get("x-airshare-human-url")).toBeTruthy();
    const prepared = await fetch(`${app.base}/xfr/prepared.txt?prepare=1`, { method: "POST", redirect: "manual" });
    const body = await prepared.text();
    expect(prepared.headers.get("content-length")).toBe(String(new TextEncoder().encode(body).byteLength));
  });
  test("receiver-first headers use the eventual upload metadata", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
    const uploading = fetch(channel.uploadUrl.replace(/\/[^/]+$/, "/actual.txt"), {
      method: "PUT", body: "hello", headers: { "content-type": "text/plain", "x-airshare-file-size": "5", "x-airshare-no-redirect": "1" },
    });
    const download = await downloading;
    expect(download.headers.get("content-disposition")).toContain("actual.txt");
    expect(download.headers.get("content-type")).toBe("text/plain");
    expect(download.headers.get("content-length")).toBe("5");
    expect(await download.text()).toBe("hello");
    expect((await uploading).status).toBe(204);
  });

  test("a rejected upload does not remove receivers waiting for a valid file", async () => {
    const app = await server();
    const channel = await createChannel(app, { contentLength: 5 });
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
    const rejected = await fetch(channel.uploadUrl, { method: "PUT", body: "hello", headers: { "x-airshare-file-size": "7", "x-airshare-no-redirect": "1" } });
    expect(rejected.status).toBe(400);
    expect((await channelStatus(app, channel)).waitingReceivers).toBe(1);
    const accepted = fetch(channel.uploadUrl, { method: "PUT", body: "hello", headers: { "x-airshare-no-redirect": "1" } });
    expect(await (await downloading).text()).toBe("hello");
    expect((await accepted).status).toBe(204);
  });

  test("Wget's default form transport header does not replace advertised raw-file media type", async () => {
    const app = await server();
    const entered = await fetch(`${app.base}/xfr/raw.bin`, { method: "POST", body: "hello", redirect: "manual", headers: { "user-agent": "Wget/1.25.0", "content-type": "application/x-www-form-urlencoded" } });
    expect(entered.status).toBe(307);
    const download = fetch(entered.headers.get("x-airshare-download-url")!, { signal: signal().signal });
    const upload = fetch(entered.headers.get("location")!, { method: "POST", body: "hello", headers: { "user-agent": "Wget/1.25.0", "content-type": "application/x-www-form-urlencoded", "x-airshare-no-redirect": "1" } });
    const response = await download;
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(await response.text()).toBe("hello");
    expect((await upload).status).toBe(204);
  });

  test("an empty file completes as a zero-byte transfer", async () => {
    const app = await server();
    const channel = await createChannel(app, { filename: "empty.txt", contentLength: 0 });
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
    const upload = await fetch(channel.uploadUrl, { method: "PUT", body: "", headers: { "x-airshare-file-size": "0", "x-airshare-no-redirect": "1" }, signal: AbortSignal.timeout(3000) });
    expect(upload.status).toBe(204);
    const download = await downloading;
    expect(download.headers.get("content-length")).toBe("0");
    expect((await download.arrayBuffer()).byteLength).toBe(0);
    expect((await channelStatus(app, channel)).completedTransfers).toBe(1);
  });

  test("a chunked upload exceeding its advertised length cannot look like a truncated success", async () => {
    const app = await server();
    const channel = await createChannel(app, { filename: "mismatch.txt", contentLength: 5 });
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal }).then(async (response) => {
      try { await response.arrayBuffer(); return response.ok ? "success" : "failed"; } catch { return "failed"; }
    }).catch(() => "failed");
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("abcdef")); controller.close(); } });
    const upload = await fetch(channel.uploadUrl, { method: "PUT", body: stream, headers: { "x-airshare-file-size": "5", "x-airshare-no-redirect": "1" }, signal: AbortSignal.timeout(3000) });
    expect(upload.status).toBe(400);
    expect(await downloading).toBe("failed");
    expect((await channelStatus(app, channel)).completedTransfers).toBe(0);
  });

  test("deleting a channel terminates an active response and uploader", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { input = controller; controller.enqueue(new TextEncoder().encode("prefix")); } });
    const uploading = fetch(channel.uploadUrl, { method: "PUT", body, headers: { "x-airshare-no-redirect": "1" }, signal: signal().signal }).catch(() => null);
    const reader = (await downloading).body!.getReader();
    expect((await reader.read()).value!.length).toBeGreaterThan(0);
    expect((await fetch(`${app.base}/api/channels/${channel.id}`, { method: "DELETE" })).status).toBe(204);
    const ended = await Promise.race([reader.read().then(() => false, () => true), Bun.sleep(600).then(() => false)]);
    expect(ended).toBe(true);
    try { input.close(); } catch {}
    const upload = await uploading;
    expect(upload === null || upload.status >= 400).toBe(true);
  });

  test("closing a channel delivers a terminal event", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const response = await fetch(channel.eventsUrl, { signal: signal().signal });
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const events = sseReader(response);
    await events.next("status");
    await fetch(`${app.base}/api/channels/${channel.id}`, { method: "DELETE" });
    expect((await events.next("closed")).data.reason).toBe("deleted");
    await events.cancel();
  });

  test("sender presence requires an actual hosting session and cannot be forged by a receiver", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const plain = signal();
    const events = sseReader(await fetch(channel.eventsUrl, { signal: plain.signal }));
    expect((await events.next("status")).data.senderOnline).toBe(false);
    await events.cancel();
    plain.abort();
    const receiverKey = new URL(channel.downloadUrl).pathname.split("/")[2];
    const receiverStatus = `${app.base}/api/channels/${receiverKey}`;
    const forged = await fetch(receiverStatus, { headers: { "x-airshare-sender-presence": "1" } }).then((response) => response.json()) as any;
    expect(forged.senderOnline).toBe(false);
    const hosted = await fetch(channel.statusUrl, { headers: { "x-airshare-sender-presence": "1" } }).then((response) => response.json()) as any;
    expect(hosted.senderOnline).toBe(true);
    await fetch(channel.statusUrl, { headers: { "x-airshare-sender-presence": "0" } });
    expect((await channelStatus(app, channel)).senderOnline).toBe(false);
    const hostingController = signal();
    const hosting = sseReader(await fetch(`${channel.eventsUrl}?hosting=1`, { signal: hostingController.signal }));
    expect((await hosting.next("status")).data.senderOnline).toBe(true);
    await hosting.cancel();
    hostingController.abort();
    await until(() => channelStatus(app, channel), (value) => !value.senderOnline);
  });

  test("cancelled subscribers release the global SSE capacity", async () => {
    const app = await server({ MAX_SUBSCRIBERS: "1" });
    const channel = await createChannel(app);
    const connection = signal();
    const events = sseReader(await fetch(channel.eventsUrl, { signal: connection.signal }));
    await events.next("status");
    expect((await fetch(`${app.base}/api/v1/track`)).status).toBe(429);
    await events.cancel();
    connection.abort();
    const next = await until(async () => fetch(`${app.base}/api/v1/track`, { signal: signal().signal }), (response) => response.status === 200);
    await next.body!.cancel();
  });

  test("regular CLI upload replays its sender URL after a successful delivery", async () => {
    const app = await server();
    const channel = await createChannel(app, { filename: "repeat.txt", contentLength: 5 });
    for (let index = 0; index < 2; index++) {
      const downloading = fetch(channel.downloadUrl, { signal: signal().signal }).then((response) => response.text());
      await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
      const upload = await fetch(channel.uploadUrl, { method: "PUT", body: "hello", redirect: "manual" });
      expect(upload.status).toBe(307);
      expect(new URL(upload.headers.get("location")!, app.base).href).toBe(channel.uploadUrl);
      expect(await downloading).toBe("hello");
    }
  });

  test("an uploader aborts cleanly while waiting for its first receiver", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const controller = signal();
    const upload = fetch(channel.uploadUrl, { method: "PUT", body: "hello", headers: { "x-airshare-no-redirect": "1" }, signal: controller.signal }).catch(() => null);
    await until(() => channelStatus(app, channel), (value) => value.activeUpload);
    controller.abort();
    await upload;
    const status = await until(() => channelStatus(app, channel), (value) => !value.activeUpload);
    expect(status.completedTransfers).toBe(0);
    expect(status.waitingReceivers).toBe(0);
  });

  test("disconnecting all active receivers stops reading an unfinished upload", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const downloadController = signal();
    const downloading = fetch(channel.downloadUrl, { signal: downloadController.signal });
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { input = controller; controller.enqueue(new TextEncoder().encode("prefix")); } });
    const uploadController = signal();
    const upload = fetch(channel.uploadUrl, { method: "PUT", body, headers: { "x-airshare-no-redirect": "1" }, signal: uploadController.signal }).catch(() => null);
    const reader = (await downloading).body!.getReader();
    expect((await reader.read()).value!.byteLength).toBe(6);
    downloadController.abort();
    const status = await until(() => channelStatus(app, channel), (value) => !value.activeUpload);
    expect(status.completedTransfers).toBe(0);
    try { input.close(); } catch {}
    uploadController.abort();
    await upload;
  });

  test("partial bodies and extra trailing chunks fail after download headers are sent", async () => {
    const app = await server();
    for (const initial of ["abc", "abcde"]) {
      const channel = await createChannel(app, { filename: "five.txt", contentLength: 5 });
      const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
      await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
      let input!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(controller) { input = controller; controller.enqueue(new TextEncoder().encode(initial)); } });
      const uploading = fetch(channel.uploadUrl, { method: "PUT", body, headers: { "x-airshare-no-redirect": "1", "x-airshare-file-size": "5" }, signal: signal().signal });
      const response = await downloading;
      const reader = response.body!.getReader();
      expect((await reader.read()).value!.byteLength).toBe(initial.length === 5 ? 4 : 3);
      if (initial.length === 5) input.enqueue(new TextEncoder().encode("f"));
      input.close();
      expect((await uploading).status).toBe(400);
      expect(await reader.read().then(() => false, () => true)).toBe(true);
      expect((await channelStatus(app, channel)).completedTransfers).toBe(0);
    }
  });

  test("a receiver arriving mid-transfer waits for the next complete upload", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const firstDownload = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { input = controller; controller.enqueue(new TextEncoder().encode("first-")); } });
    const firstUpload = fetch(channel.uploadUrl, { method: "PUT", body, headers: { "x-airshare-no-redirect": "1" }, signal: signal().signal });
    const firstReader = (await firstDownload).body!.getReader();
    expect(new TextDecoder().decode((await firstReader.read()).value)).toBe("first-");
    const secondDownload = fetch(channel.downloadUrl, { signal: signal().signal }).then((response) => response.text());
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1 && value.activeUpload);
    input.enqueue(new TextEncoder().encode("done")); input.close();
    let rest = "";
    while (true) { const result = await firstReader.read(); if (result.done) break; rest += new TextDecoder().decode(result.value); }
    expect(rest).toBe("done");
    expect((await firstUpload).status).toBe(204);
    expect((await channelStatus(app, channel)).waitingReceivers).toBe(1);
    const secondUpload = await fetch(channel.uploadUrl, { method: "PUT", body: "first-done", headers: { "x-airshare-no-redirect": "1", "x-airshare-file-size": "10" } });
    expect(secondUpload.status).toBe(204);
    expect(await secondDownload).toBe("first-done");
    expect((await channelStatus(app, channel)).completedTransfers).toBe(2);
  });

  test("a stalled multicast peer is dropped while a healthy receiver completes", async () => {
    const app = await server({ RECEIVER_STALL_TIMEOUT_MS: "150" });
    const total = 24 * 1024 * 1024;
    const channel = await createChannel(app, { filename: "multicast.bin", contentLength: total });
    const url = new URL(channel.downloadUrl);
    const stalled = connect({ host: "127.0.0.1", port: Number(url.port) });
    stalled.on("error", () => {});
    stalled.pause();
    await new Promise<void>((resolve) => stalled.once("connect", resolve));
    stalled.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
    const receiving = fetch(channel.downloadUrl, { signal: signal().signal }).then(async (response) => {
      const reader = response.body!.getReader(); let count = 0;
      while (true) { const result = await reader.read(); if (result.done) break; count += result.value.byteLength; }
      return count;
    });
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 2);
    let remaining = total;
    const chunk = new Uint8Array(65_536).fill(37);
    const body = new ReadableStream({ pull(controller) { if (!remaining) { controller.close(); return; } controller.enqueue(chunk); remaining -= chunk.length; } });
    const uploadController = signal();
    const uploading = fetch(channel.uploadUrl, { method: "PUT", body, headers: { "content-length": String(total), "x-airshare-no-redirect": "1" }, signal: uploadController.signal }).catch(() => null);
    try {
      const result = await Promise.race([receiving, Bun.sleep(2000).then(() => -1)]);
      expect(result).toBe(total);
      expect((await uploading)!.status).toBe(204);
      expect((await channelStatus(app, channel)).completedTransfers).toBe(1);
    } finally { stalled.destroy(); uploadController.abort(); }
  });

  test("uploads above 128 MiB are relayed with matching streaming hashes", async () => {
    const app = await server();
    const total = 129 * 1024 * 1024;
    const channel = await createChannel(app, { filename: "large.bin", contentLength: total });
    const inputHash = new Bun.CryptoHasher("sha256");
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal }).then(async (response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(total));
      const hash = new Bun.CryptoHasher("sha256"); let size = 0;
      const reader = response.body!.getReader();
      while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; hash.update(chunk.value); }
      return { size, hash: hash.digest("hex") };
    });
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
    let remaining = total;
    const chunk = new Uint8Array(65_536).fill(0x5a);
    const body = new ReadableStream({ pull(controller) { if (!remaining) { controller.close(); return; } inputHash.update(chunk); controller.enqueue(chunk); remaining -= chunk.length; } });
    const uploading = fetch(channel.uploadUrl, { method: "PUT", body, headers: { "content-length": String(total), "x-airshare-no-redirect": "1" }, signal: signal().signal });
    const result = await downloading;
    expect((await uploading).status).toBe(204);
    expect(result.size).toBe(total);
    expect(result.hash).toBe(inputHash.digest("hex"));
  }, 20_000);
});

describe("metadata lifetime", () => {
  test("a client's used-channel quota survives restart and releases on deletion", async () => {
    const dir = await temporaryDataDir();
    const env = { DATA_DIR: dir.path, MAX_CHANNELS_PER_CLIENT: "1", CHANNEL_CREATION_BURST: "0", TRUSTED_PROXIES: "127.0.0.1" };
    let active = await server(env);
    try {
      const channel = await createChannel(active, { contentLength: 0 });
      const receiving = fetch(channel.downloadUrl, { signal: signal().signal });
      await until(() => channelStatus(active, channel), (value) => value.waitingReceivers === 1);
      expect((await fetch(channel.uploadUrl, { method: "PUT", body: "", headers: { "x-airshare-no-redirect": "1" } })).status).toBe(204);
      await (await receiving).arrayBuffer();
      await active.close(); servers.splice(servers.indexOf(active), 1);
      active = await server(env);
      expect((await channelStatus(active, channel)).completedTransfers).toBe(1);
      const blocked = await fetch(`${active.base}/api/channels`, { method: "POST", body: "{}" });
      expect(blocked.status).toBe(429);
      expect((await blocked.json() as any).reason).toBe("channel_quota");
      expect((await fetch(`${active.base}/api/channels`, { method: "POST", body: "{}", headers: { "x-forwarded-for": "203.0.113.99" } })).status).toBe(201);
      expect((await fetch(`${active.base}/api/channels/${channel.id}`, { method: "DELETE" })).status).toBe(204);
      expect((await fetch(`${active.base}/api/channels`, { method: "POST", body: "{}" })).status).toBe(201);
    } finally {
      if (servers.includes(active)) { await active.close(); servers.splice(servers.indexOf(active), 1); }
      await dir.remove();
    }
  });

  test("creation admission covers every entry route and ignores spoofed forwarding headers by default", async () => {
    const app = await server({ CHANNEL_CREATION_BURST: "2", CHANNEL_CREATION_INTERVAL_MS: "60000", TRUSTED_PROXIES: "" });
    await createChannel(app);
    expect((await fetch(`${app.base}/xfr?prepare=1`, { method: "POST", redirect: "manual" })).status).toBe(201);
    for (const [path, method, body] of [["/api/channels", "POST", "{}"], ["/api/v1/channel", "POST", "{}"], ["/xfr", "GET", undefined], ["/file.txt", "PUT", "data"], ["/", "GET", undefined]] as const) {
      const response = await fetch(`${app.base}${path}`, { method, body, redirect: "manual", headers: { "user-agent": "curl/8.21.0", "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}` } });
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    }
  });

  test("explicit proxy trust selects the nearest untrusted client and groups IPv6 client prefixes", async () => {
    const app = await server({ CHANNEL_CREATION_BURST: "1", CHANNEL_CREATION_INTERVAL_MS: "60000", TRUSTED_PROXIES: "127.0.0.1,10.0.0.0/8" });
    const create = (forwarded: string) => fetch(`${app.base}/api/channels`, { method: "POST", body: "{}", headers: { "x-forwarded-for": forwarded } });
    expect((await create("198.51.100.1, 203.0.113.1, 10.1.1.1")).status).toBe(201);
    expect((await create("198.51.100.2, 203.0.113.1, 10.1.1.1")).status).toBe(429);
    expect((await create("203.0.113.2")).status).toBe(201);
    expect((await create("2001:db8:1:2::1")).status).toBe(201);
    expect((await create("2001:db8:1:2::abcd")).status).toBe(429);
    expect((await create("2001:db8:1:3::1")).status).toBe(201);
  });

  test("an untrusted bridge gateway cannot rotate its bucket with forged forwarding prefixes", async () => {
    const app = await server({ CHANNEL_CREATION_BURST: "2", CHANNEL_CREATION_INTERVAL_MS: "60000", TRUSTED_PROXIES: "127.0.0.1" });
    const create = (forwarded: string) => fetch(`${app.base}/api/channels`, {
      method: "POST", body: "{}", headers: { "x-forwarded-for": forwarded },
    });
    expect((await create("203.0.113.1, 127.0.0.2")).status).toBe(201);
    expect((await create("203.0.113.2, 127.0.0.2")).status).toBe(201);
    expect((await create("203.0.113.3, 127.0.0.2")).status).toBe(429);
    expect((await create("198.51.100.1, 127.0.0.3")).status).toBe(201);
  });

  test("unused capacity is reclaimed without evicting a hosting or previously used channel", async () => {
    const app = await server({ MAX_CHANNELS: "2" });
    const protectedChannel = await createChannel(app);
    const hosting = sseReader(await fetch(`${protectedChannel.eventsUrl}?hosting=1`, { signal: signal().signal }));
    await hosting.next("status");
    const unused = await createChannel(app);
    const replacement = await createChannel(app);
    expect((await fetch(`${app.base}/api/channels/${unused.id}`)).status).toBe(404);
    expect((await fetch(`${app.base}/api/channels/${protectedChannel.id}`)).status).toBe(200);
    expect((await fetch(`${app.base}/api/channels/${replacement.id}`)).status).toBe(200);
    const anotherHosting = sseReader(await fetch(`${replacement.eventsUrl}?hosting=1`, { signal: signal().signal }));
    await anotherHosting.next("status");
    expect((await fetch(`${app.base}/api/channels`, { method: "POST", body: "{}" })).status).toBe(503);
    await hosting.cancel(); await anotherHosting.cancel();
  });

  test("receiver status polling cannot retain an unused channel, while a waiting receiver is protected", async () => {
    const app = await server({ UNUSED_CHANNEL_TTL_MS: "120", CHANNEL_TTL_MS: "60000", CLEANUP_INTERVAL_MS: "20" });
    const unused = await createChannel(app);
    const receiverKey = new URL(unused.downloadUrl).pathname.split("/")[2];
    const response = await until(() => fetch(`${app.base}/api/channels/${receiverKey}`), (value) => value.status === 404, 1200);
    expect(response.status).toBe(404);
    const waiting = await createChannel(app);
    const downloading = fetch(waiting.downloadUrl, { signal: signal().signal });
    void downloading.catch(() => {});
    await until(() => channelStatus(app, waiting), (value) => value.waitingReceivers === 1);
    await Bun.sleep(180);
    expect((await fetch(`${app.base}/api/channels/${waiting.id}`)).status).toBe(200);
  });

  test("an unused hosted share receives a fresh idle grace period after a brief reconnect", async () => {
    const app = await server({ UNUSED_CHANNEL_TTL_MS: "120", CHANNEL_TTL_MS: "60000", CLEANUP_INTERVAL_MS: "20" });
    const channel = await createChannel(app);
    const first = signal();
    const hosting = sseReader(await fetch(`${channel.eventsUrl}?hosting=1`, { signal: first.signal }));
    await hosting.next("status");
    await Bun.sleep(180);
    await hosting.cancel(); first.abort();
    const second = signal();
    const reconnect = await fetch(`${channel.eventsUrl}?hosting=1`, { signal: second.signal });
    expect(reconnect.status).toBe(200);
    const connected = sseReader(reconnect);
    expect((await connected.next("status")).data.senderOnline).toBe(true);
    await connected.cancel(); second.abort();
    const expired = await until(() => fetch(channel.statusUrl), (response) => response.status === 404, 1200);
    expect(expired.status).toBe(404);
  });

  test("an eager creation body keeps its channel alive until the initial redirect request finishes", async () => {
    const app = await server({ UNUSED_CHANNEL_TTL_MS: "120", CHANNEL_TTL_MS: "60000", CLEANUP_INTERVAL_MS: "20" });
    const base = new URL(app.base);
    const socket = connect(Number(base.port), "127.0.0.1");
    socket.on("error", () => {});
    let wire = "";
    const headers = new Promise<string>((resolve) => socket.on("data", (value) => { wire += value.toString(); if (wire.includes("\r\n\r\n")) resolve(wire); }));
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    try {
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(`POST /xfr/slow.bin HTTP/1.1\r\nHost: ${base.host}\r\nContent-Length: 10\r\nConnection: close\r\n\r\n12345`);
      const uploadUrl = (await headers).match(/^x-airshare-upload-url: (.+)$/mi)![1]!.trim();
      const status = new URL(uploadUrl); status.pathname = status.pathname.replace(/\/upload(?:\/.*)?$/, "");
      await Bun.sleep(180);
      expect((await fetch(status)).status).toBe(200);
      socket.write("67890");
      await closed;
      expect((await fetch(status)).status).toBe(200);
    } finally { socket.destroy(); }
  });

  test("per-client receiver and subscriber quotas recover after cancellation", async () => {
    const app = await server({ MAX_RECEIVERS_PER_CLIENT: "1", MAX_SUBSCRIBERS_PER_CLIENT: "1" });
    const first = await createChannel(app);
    const second = await createChannel(app);
    const receiver = signal();
    const waiting = fetch(first.downloadUrl, { signal: receiver.signal }).catch(() => null);
    await until(() => channelStatus(app, first), (value) => value.waitingReceivers === 1);
    expect((await fetch(second.downloadUrl, { signal: AbortSignal.timeout(500) })).status).toBe(429);
    receiver.abort(); await waiting;
    await until(() => channelStatus(app, first), (value) => value.waitingReceivers === 0);
    const connection = signal();
    const events = sseReader(await fetch(first.eventsUrl, { signal: connection.signal }));
    await events.next("status");
    expect((await fetch(second.eventsUrl, { signal: AbortSignal.timeout(500) })).status).toBe(429);
    await events.cancel(); connection.abort();
    const next = await until(() => fetch(second.eventsUrl, { signal: signal().signal }), (response) => response.status === 200);
    await next.body!.cancel();
  });
  test("channel metadata survives restart while volatile presence is reset", async () => {
    const dir = await temporaryDataDir();
    try {
      const first = await server({ DATA_DIR: dir.path });
      const channel = await createChannel(first, { filename: "remembered.txt", contentLength: 7 });
      await first.close();
      servers.splice(servers.indexOf(first), 1);
      const second = await server({ DATA_DIR: dir.path });
      const response = await fetch(`${second.base}/api/channels/${channel.id}`);
      expect(response.status).toBe(200);
      const restored = await response.json() as any;
      expect(restored.file).toEqual({ filename: "remembered.txt", contentType: "application/octet-stream", contentLength: 7 });
      expect(restored.senderOnline).toBe(false);
      expect(restored.activeUpload).toBe(false);
      await second.close();
      servers.splice(servers.indexOf(second), 1);
    } finally { await dir.remove(); }
  });

  test("channel capacity and idle expiration bound persisted state", async () => {
    const app = await server({ MAX_CHANNELS: "1", CHANNEL_TTL_MS: "120", CLEANUP_INTERVAL_MS: "20" });
    const channel = await createChannel(app, { contentLength: 0 });
    const download = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
    expect((await fetch(channel.uploadUrl, { method: "PUT", body: "", headers: { "x-airshare-no-redirect": "1" } })).status).toBe(204);
    await (await download).arrayBuffer();
    expect((await fetch(`${app.base}/api/channels`, { method: "POST", body: "{}" })).status).toBe(503);
    await Bun.sleep(180);
    expect((await fetch(`${app.base}/api/channels/${channel.id}`)).status).toBe(404);
    expect((await fetch(`${app.base}/api/channels`, { method: "POST", body: "{}" })).status).toBe(201);
  });

  test("an active transfer is never expired by the idle metadata timer", async () => {
    const app = await server({ CHANNEL_TTL_MS: "120", CLEANUP_INTERVAL_MS: "20" });
    const channel = await createChannel(app);
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(() => channelStatus(app, channel), (value) => value.waitingReceivers === 1);
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { input = controller; controller.enqueue(new TextEncoder().encode("prefix")); } });
    const uploading = fetch(channel.uploadUrl, { method: "PUT", body, headers: { "x-airshare-no-redirect": "1" }, signal: signal().signal });
    const reader = (await downloading).body!.getReader();
    await reader.read();
    await Bun.sleep(180);
    expect((await channelStatus(app, channel)).activeUpload).toBe(true);
    input.close();
    expect((await reader.read()).done).toBe(true);
    expect((await uploading).status).toBe(204);
  });
});
