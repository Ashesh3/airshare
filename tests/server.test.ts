import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { keyHash, seal } from "../src/capability-keys";
import {
  createChannel,
  channelStatus,
  rawKeysIn,
  sseReader,
  startServer,
  temporaryDataDir,
  until,
  type RunningServer,
} from "./server-helper";

const senderKeyOf = (channel: { uploadUrl: string }) =>
  new URL(channel.uploadUrl).pathname.match(/^\/(?:u|api\/channels)\/([^/]+)/)![1]!;
const senderStatusOf = (uploadUrl: string) => `${new URL(uploadUrl).origin}/api/channels/${senderKeyOf({ uploadUrl })}`;
const receiverKeyOf = (channel: { downloadUrl: string }) => new URL(channel.downloadUrl).pathname.split("/")[2]!;

const jsonType = { "content-type": "application/json" };
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
  test("other websites can't create, change or delete shares, and can read only downloads and status", async () => {
    const app = await server();
    const evil = { origin: "https://evil.example" };
    const create = (headers: Record<string, string>) =>
      fetch(`${app.base}/api/channels`, { method: "POST", headers, body: "{}" });
    const refused = await create({ ...jsonType, ...evil });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: "cross_origin" });
    expect((await create({ ...jsonType, origin: "null" })).status).toBe(403);
    // A cross-site form or text/plain fetch is a "simple" request that skips the preflight.
    expect((await create({ "content-type": "text/plain;charset=UTF-8" })).status).toBe(415);
    expect((await create({})).status).toBe(415);
    const own = await create({ ...jsonType, origin: app.base });
    expect(own.status).toBe(201);
    expect(own.headers.get("access-control-allow-origin")).toBeNull();
    // Behind a TLS proxy without PUBLIC_URL the page origin is https while the relay sees http on the same host.
    expect((await create({ ...jsonType, origin: app.base.replace("http:", "https:") })).status).toBe(201);
    const channel = (await own.json()) as any;
    expect((await fetch(channel.deleteUrl, { method: "DELETE", headers: evil })).status).toBe(403);
    expect((await fetch(channel.uploadUrl, { method: "PUT", body: "x", headers: evil })).status).toBe(403);
    expect(
      (
        await fetch(`${app.base}/api/presence`, {
          method: "POST",
          headers: { ...jsonType, ...evil },
          body: JSON.stringify({ keys: [channel.id], hosting: true }),
        })
      ).status,
    ).toBe(403);
    expect((await channelStatus(app, channel)).senderOnline).toBe(false);
    for (const url of [channel.statusUrl, channel.downloadUrl, `${app.base}/healthz`]) {
      const response = await fetch(url, { method: "HEAD", headers: evil });
      expect(response.headers.get("access-control-allow-origin"), url).toBe("*");
    }
    for (const url of [
      `${app.base}/`,
      channel.humanUrl,
      `${app.base}/api/qr?url=${encodeURIComponent(channel.humanUrl)}`,
    ]) {
      expect((await fetch(url, { headers: evil })).headers.get("access-control-allow-origin"), url).toBeNull();
    }
    const writePreflight = await fetch(`${app.base}/api/channels`, {
      method: "OPTIONS",
      headers: { ...evil, "access-control-request-method": "POST" },
    });
    expect(writePreflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(writePreflight.headers.get("access-control-allow-methods")).toBeNull();
    const readPreflight = await fetch(channel.downloadUrl, {
      method: "OPTIONS",
      headers: { ...evil, "access-control-request-method": "GET" },
    });
    expect(readPreflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(readPreflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
    expect((await fetch(channel.statusUrl)).status).toBe(200);
  });

  test("a browser that reports another site in Sec-Fetch-Site can't create shares", async () => {
    const app = await server({ CHANNEL_CREATION_BURST: "2", CHANNEL_CREATION_INTERVAL_MS: "60000" });
    const chrome = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36" };
    const attempts = [
      ["/xfr?prepare=1", "POST", undefined, {}],
      ["/file.txt", "PUT", "data", {}],
      ["/api/channels", "POST", "{}", jsonType],
      ["/api/v1/channel", "POST", "{}", jsonType],
    ] as const;
    for (const site of ["cross-site", "same-site"])
      for (const [path, method, body, headers] of attempts) {
        const response = await fetch(`${app.base}${path}`, {
          method,
          body,
          redirect: "manual",
          headers: { ...chrome, ...headers, "sec-fetch-site": site },
        });
        expect(response.status, `${site} ${method} ${path}`).toBe(403);
        expect(await response.json()).toMatchObject({ reason: "cross_origin" });
      }
    // This server's own pages and a request typed into the browser still work, and the refusals used up no creation allowance.
    const own = await fetch(`${app.base}/api/channels`, {
      method: "POST",
      body: "{}",
      headers: { ...chrome, ...jsonType, "sec-fetch-site": "same-origin" },
    });
    expect(own.status).toBe(201);
    expect(
      (await fetch(`${app.base}/xfr?prepare=1`, { method: "POST", headers: { ...chrome, "sec-fetch-site": "none" } }))
        .status,
    ).toBe(201);
  });

  test("an incomplete control body times out and closes its connection, while a slow upload keeps going", async () => {
    const app = await server({ CONTROL_BODY_TIMEOUT_MS: "300" });
    const url = new URL(app.base);
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let reply = "";
    const closed = new Promise<number>((resolve) => socket.on("close", () => resolve(Date.now())));
    socket.on("data", (chunk) => {
      reply += chunk;
    });
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const started = Date.now();
    socket.write(
      `POST /api/channels HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"filename":`,
    );
    const closedAt = await Promise.race([closed, Bun.sleep(3000).then(() => 0)]);
    expect(closedAt, "the connection stays open").toBeGreaterThan(0);
    expect(closedAt - started).toBeLessThan(2000);
    expect(reply).toStartWith("HTTP/1.1 408");
    expect(reply).toContain('"reason":"body_timeout"');
    // Transfers are not control requests: gaps longer than the limit are fine.
    const channel = await createChannel(app);
    const downloading = fetch(channel.downloadUrl).then((r) => r.text());
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent === 3) return controller.close();
        await Bun.sleep(400);
        controller.enqueue(new TextEncoder().encode(String(sent++)));
      },
    });
    expect(
      (await fetch(channel.uploadUrl, { method: "PUT", body, headers: { "x-airshare-no-redirect": "1" } })).status,
    ).toBe(200);
    expect(await downloading).toBe("012");
  });

  test("a page served from a host other than PUBLIC_URL, directly or through a proxy, can still write to its own server", async () => {
    const post = (app: RunningServer, headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const url = new URL(app.base);
        const socket = connect({ host: url.hostname, port: Number(url.port) });
        let reply = "";
        socket.on("data", (chunk) => {
          reply += chunk;
          const status = reply.match(/^HTTP\/1\.1 (\d{3})/)?.[1];
          if (status) {
            socket.destroy();
            resolve(Number(status));
          }
        });
        socket.on("error", reject);
        socket.write(
          `POST /api/channels HTTP/1.1\r\n${Object.entries({
            "content-type": "application/json",
            "content-length": "2",
            ...headers,
          })
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join("")}\r\n{}`,
        );
      });
    const lan = await server({ PUBLIC_URL: "http://192.168.1.50:3070", CHANNEL_CREATION_BURST: "0" });
    const host = new URL(lan.base).host;
    expect(await post(lan, { host, origin: lan.base })).toBe(201);
    expect(
      await post(lan, {
        host: `localhost:${new URL(lan.base).port}`,
        origin: `http://localhost:${new URL(lan.base).port}`,
      }),
    ).toBe(201);
    expect(await post(lan, { host, origin: "http://192.168.1.50:3070" })).toBe(201);
    expect(await post(lan, { host, origin: "http://192.168.1.51:3070" })).toBe(403);
    // A Host without a port names the default port of the page's scheme; a TLS proxy may still turn https into http.
    expect(await post(lan, { host: "share.lan", origin: "http://share.lan" })).toBe(201);
    expect(await post(lan, { host: "share.lan", origin: "https://share.lan" })).toBe(201);
    // Another port on the same name is another site, which a client-written Host can't vouch for.
    expect(await post(lan, { host: "share.lan", origin: "http://share.lan:8080" })).toBe(403);
    expect(await post(lan, { host: "share.lan", origin: "https://share.lan:8443" })).toBe(403);
    expect(await post(lan, { host: "share.lan", origin: "http://other.lan" })).toBe(403);
    const proxied = await server({ TRUSTED_PROXIES: "127.0.0.1", CHANNEL_CREATION_BURST: "0" });
    const forwarded = {
      host: "airshare:3070",
      "x-forwarded-host": "files.example:8443",
      origin: "https://files.example:8443",
    };
    expect(await post(proxied, forwarded)).toBe(201);
    expect(await post(proxied, { ...forwarded, origin: "https://evil.example:8443" })).toBe(403);
    expect(await post(proxied, { ...forwarded, origin: "https://files.example:9443" })).toBe(403);
    // A trusted proxy forwarding nginx's $host has dropped the port the page was loaded on.
    expect(await post(proxied, { ...forwarded, "x-forwarded-host": "files.example" })).toBe(201);
    expect(
      await post(proxied, { ...forwarded, "x-forwarded-host": "files.example", origin: "https://other.example:8443" }),
    ).toBe(403);
    // The proxy's own bare Host gets no such allowance.
    expect(await post(proxied, { host: "files.example", origin: "https://files.example:8443" })).toBe(403);
    // Without proxy trust, a forwarded host is just a client-written header.
    expect(await post(lan, forwarded)).toBe(403);
  });

  test("receiver URLs and events reveal no sender or owner capability", async () => {
    const app = await server();
    const owner = await createChannel(app, { filename: "private.txt" });
    const senderKey = senderKeyOf(owner);
    const receiverKey = new URL(owner.downloadUrl).pathname.split("/")[2];
    expect(senderKey).not.toBe(owner.id);
    expect(receiverKey).not.toBe(owner.id);
    expect(receiverKey).not.toBe(senderKey);
    const receiver = (await fetch(`${app.base}/api/channels/${receiverKey}`).then((r) => r.json())) as any;
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
    const response = await fetch(`${app.base}/api/v1/channel`, { method: "POST", headers: jsonType, body: "{}" });
    const created = (await response.json()) as any;
    const wrong = await fetch(`${app.base}/api/v1/channel/${created.keys.receiver_key}/subscribe/missing`, {
      method: "POST",
    });
    expect([403, 404]).toContain(wrong.status);
  });

  test("invalid metadata is a controlled client error", async () => {
    const app = await server();
    for (const body of [
      null,
      [],
      5,
      { filename: 12 },
      { contentType: {} },
      { contentType: "not a media type" },
      { contentLength: -1 },
      { contentLength: 0.5 },
      { contentLength: "12" },
      { contentType: "text/plain\r\nx-injected: yes" },
    ]) {
      const response = await fetch(`${app.base}/api/channels`, {
        method: "POST",
        headers: jsonType,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    const oversized = await fetch(`${app.base}/api/channels`, {
      method: "POST",
      headers: jsonType,
      body: JSON.stringify({ filename: "x".repeat(20000) }),
    });
    expect(oversized.status).toBe(413);
    const malformedPath = await fetch(`${app.base}/recv/%ZZ`);
    expect(malformedPath.status).toBe(400);
  });

  test("Station metadata validation also rejects an explicit null file object", async () => {
    const app = await server();
    const response = await fetch(`${app.base}/api/v1/channel`, {
      method: "POST",
      headers: jsonType,
      body: '{"file_details":null}',
    });
    expect(response.status).toBe(400);
  });

  test("chunked JSON bodies are capped independently of transfer size limits", async () => {
    const app = await server({ MAX_METADATA_BYTES: "1024" });
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ filename: "x".repeat(2000) })));
        controller.close();
      },
    });
    const response = await fetch(`${app.base}/api/channels`, { method: "POST", headers: jsonType, body: input });
    expect(response.status).toBe(413);
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
  });

  test("encoded Windows separators cannot escape the static asset directory", async () => {
    const app = await server();
    for (const path of [
      "/..%5cpackage.json",
      "/%2e%2e%5csrc%5cserver.ts",
      "/%2e%2e%2fpackage.json",
      "/%2FC%3A%2FWindows%2Fwin.ini",
    ]) {
      const response = await fetch(`${app.base}${path}`);
      expect(response.status).toBe(404);
    }
    expect((await fetch(`${app.base}/styles.css`)).status).toBe(200);
  });

  test("CLI content negotiation still serves existing static assets", async () => {
    const app = await server();
    const response = await fetch(`${app.base}/styles.css`, {
      headers: { "user-agent": "curl/8.21.0" },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
  });

  test("Station tracker subscriptions and transfer events stay role-specific", async () => {
    const app = await server();
    const tracking = sseReader(await fetch(`${app.base}/api/v1/track`, { signal: signal().signal }));
    const trackerKey = (await tracking.next("tracker_event")).data.initialized.tracker_key;
    const created = await fetch(`${app.base}/api/v1/channel`, {
      method: "POST",
      headers: jsonType,
      body: JSON.stringify({
        file_details: { filename: "tracked.txt", content_length: 5 },
        tracker: { tracker_key: trackerKey, tag: "created", perspective: "receiver" },
      }),
    });
    expect(created.status).toBe(200);
    const channel = (await created.json()) as any;
    const subscribed = (await tracking.next("tracker_event")).data.subscribed;
    expect(subscribed.key).toEqual({ receiver: channel.keys.receiver_key });
    expect(JSON.stringify(subscribed)).not.toContain(channel.keys.channel_key);
    expect(JSON.stringify(subscribed)).not.toContain(channel.keys.sender_key);
    const forbidden = await fetch(`${app.base}/api/v1/channel/${channel.keys.receiver_key}/subscribe/${trackerKey}`, {
      method: "POST",
    });
    expect(forbidden.status).toBe(404);
    const downloading = fetch(`${channel.urls.receiver_url}?tracker=${trackerKey}&tag=receiving`, {
      signal: signal().signal,
    }).then((response) => response.text());
    await until(
      () => channelStatus(app, { id: channel.keys.channel_key }),
      (value) => value.waitingReceivers === 1,
    );
    const uploading = fetch(channel.urls.sender_url, {
      method: "PUT",
      body: "hello",
      headers: {
        "com.station307.no-redirect": "true",
        "com.station307.tracker": trackerKey,
        "com.station307.tag": "sending",
      },
    });
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
      method: "POST",
      body: "{}",
      headers: { ...jsonType, "x-forwarded-host": "attacker.test", "x-forwarded-proto": "http" },
    });
    const channel = (await response.json()) as any;
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
    for (const value of [
      "https://elsewhere.test/r/secret",
      "javascript:alert(1)",
      "data:text/html,test",
      "not a URL",
      `${app.base}/${"x".repeat(2050)}`,
    ]) {
      expect((await fetch(`${app.base}/api/qr?url=${encodeURIComponent(value)}`)).status).toBe(400);
    }
  });

  test("Unicode and control characters in filenames produce safe attachment headers", async () => {
    const app = await server();
    const filename = "रिपोर्ट😀\u202e\u0001.pdf";
    const channel = await createChannel(app, { filename, contentLength: 4 });
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    const uploading = fetch(channel.uploadUrl, {
      method: "PUT",
      body: "data",
      headers: { "x-airshare-no-redirect": "1" },
    });
    const response = await downloading;
    const disposition = response.headers.get("content-disposition")!;
    expect(disposition).toContain("filename*=UTF-8''%E0%A4%B0");
    expect(disposition).not.toContain("%E2%80%AE");
    expect(disposition).not.toMatch(/[\u0000-\u001f\u007f-\uffff]/);
    expect(await response.text()).toBe("data");
    expect((await uploading).status).toBe(200);
  });

  test("downloads are sandboxed and not embeddable, and receivers never see the sender's error text", async () => {
    const app = await server();
    const channel = await createChannel(app, { filename: "page.html", contentType: "text/html", contentLength: 4 });
    const head = await fetch(channel.downloadUrl, { method: "HEAD" });
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("da"));
        controller.enqueue(new TextEncoder().encode("too long body"));
        controller.close();
      },
    });
    expect(
      (await fetch(channel.uploadUrl, { method: "PUT", body, headers: { "x-airshare-no-redirect": "1" } })).status,
    ).toBe(400);
    for (const [method, response] of [
      ["HEAD", head],
      ["GET", await downloading],
    ] as const) {
      expect(response.headers.get("content-security-policy"), method).toBe("sandbox; default-src 'none'");
      expect(response.headers.get("cross-origin-resource-policy"), method).toBe("same-origin");
      expect(response.headers.get("content-disposition"), method).toStartWith("attachment;");
    }
    const owner = await until(
      () => channelStatus(app, channel),
      (value) => value.lastError !== undefined,
    );
    expect(owner.lastError).toContain("advertised file size");
    const receiver = (await fetch(`${app.base}/api/channels/${receiverKeyOf(channel)}`).then((r) => r.json())) as any;
    expect(receiver.lastUploadReason).toBeUndefined();
    expect(receiver).not.toHaveProperty("lastError");
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
    expect((await events.next("tracker_event")).data.ping).toEqual({});
    await events.cancel();
  }, 10_000);

  test("receiver departure is retryable and finishes the abandoned upload response without draining its remainder", async () => {
    const app = await server();
    for (const browser of [true, false]) {
      const channel = await createChannel(app, { contentLength: 8 * 1024 * 1024 });
      const receiverController = signal();
      const downloading = fetch(channel.downloadUrl, { signal: receiverController.signal });
      await until(
        () => channelStatus(app, channel),
        (value) => value.waitingReceivers === 1,
      );
      const uploaderController = signal();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(65_536));
        },
      });
      const uploading = fetch(channel.uploadUrl, {
        method: "PUT",
        body,
        redirect: "manual",
        signal: uploaderController.signal,
        headers: {
          "content-length": String(8 * 1024 * 1024),
          "x-airshare-upload-id": "cancelled-attempt",
          ...(browser ? { "x-airshare-no-redirect": "1" } : {}),
        },
      })
        .then(async (response) => ({
          status: response.status,
          location: response.headers.get("location"),
          text: await response.text(),
        }))
        .catch(() => null);
      const reader = (await downloading).body!.getReader();
      await reader.read();
      receiverController.abort();
      const status = await until(
        () => channelStatus(app, channel),
        (value) => !value.activeUpload,
      );
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
      const publicStatus = (await fetch(`${app.base}/api/channels/${receiverKey}`).then((response) =>
        response.json(),
      )) as any;
      expect(publicStatus.lastUploadId).toBeUndefined();
    }
  });

  test("stdin channels are prepared without replaying their non-rewindable request body", async () => {
    const app = await server();
    const unsafe = await fetch(`${app.base}/xfr/piped.txt`, {
      method: "PUT",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("unprepared"));
          controller.close();
        },
      }),
      redirect: "manual",
    });
    expect(unsafe.status).toBe(411);
    expect(unsafe.headers.get("x-airshare-download-url")).toBeNull();
    const prepared = await fetch(`${app.base}/xfr/piped.txt?prepare=1`, { method: "POST", redirect: "manual" });
    expect(prepared.status).toBe(201);
    const uploadUrl = (await prepared.text()).trim();
    expect(uploadUrl).toBe(prepared.headers.get("x-airshare-upload-url")!);
    const downloading = fetch(prepared.headers.get("x-airshare-download-url")!, { signal: signal().signal }).then(
      (response) => response.text(),
    );
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("complete pipe"));
        controller.close();
      },
    });
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
    expect(initial.headers.get("com.station307.human.web.url")).toBeTruthy();
    const prepared = await fetch(`${app.base}/xfr/prepared.txt?prepare=1`, { method: "POST", redirect: "manual" });
    const body = await prepared.text();
    expect(prepared.headers.get("content-length")).toBe(String(new TextEncoder().encode(body).byteLength));
  });
  test("receiver-first headers use the eventual upload metadata", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    const uploading = fetch(channel.uploadUrl.replace(/\/[^/]+$/, "/actual.txt"), {
      method: "PUT",
      body: "hello",
      headers: { "content-type": "text/plain", "x-airshare-file-size": "5", "x-airshare-no-redirect": "1" },
    });
    const download = await downloading;
    expect(download.headers.get("content-disposition")).toContain("actual.txt");
    expect(download.headers.get("content-type")).toBe("text/plain");
    expect(download.headers.get("content-length")).toBe("5");
    expect(await download.text()).toBe("hello");
    expect((await uploading).status).toBe(200);
  });

  test("a rejected upload does not remove receivers waiting for a valid file", async () => {
    const app = await server();
    const channel = await createChannel(app, { contentLength: 5 });
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    const rejected = await fetch(channel.uploadUrl, {
      method: "PUT",
      body: "hello",
      headers: { "x-airshare-file-size": "7", "x-airshare-no-redirect": "1" },
    });
    expect(rejected.status).toBe(400);
    expect((await channelStatus(app, channel)).waitingReceivers).toBe(1);
    const accepted = fetch(channel.uploadUrl, {
      method: "PUT",
      body: "hello",
      headers: { "x-airshare-no-redirect": "1" },
    });
    expect(await (await downloading).text()).toBe("hello");
    expect((await accepted).status).toBe(200);
  });

  test("an upload's own Content-Length beats a size stored from an earlier file", async () => {
    const app = await server();
    const channel = await createChannel(app, { filename: "reused.bin", contentLength: 5 });
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    const upload = fetch(channel.uploadUrl, {
      method: "PUT",
      body: "seven!!",
      headers: { "x-airshare-no-redirect": "1" },
    });
    const download = await downloading;
    expect(download.headers.get("content-length")).toBe("7");
    expect(await download.text()).toBe("seven!!");
    expect((await upload).ok).toBe(true);
    const mismatch = await fetch(channel.uploadUrl, {
      method: "PUT",
      body: "seven!!",
      headers: { "x-airshare-file-size": "5", "x-airshare-no-redirect": "1" },
    });
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as any).reason).toBe("size_mismatch");
  });

  test("a new upload replaces a waiting upload, and is refused only while bytes are flowing", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const stale = fetch(channel.uploadUrl, {
      method: "PUT",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("stale"));
        },
      }),
      headers: { "x-airshare-no-redirect": "1", "x-airshare-upload-id": "stale-attempt" },
      signal: signal().signal,
    });
    await until(
      () => channelStatus(app, channel),
      (value) => value.activeUploadId === "stale-attempt",
    );
    const fresh = fetch(channel.uploadUrl, {
      method: "PUT",
      body: "fresh",
      headers: { "x-airshare-no-redirect": "1", "x-airshare-upload-id": "fresh-attempt" },
    });
    const replaced = await stale;
    expect(replaced.status).toBe(409);
    expect(await replaced.json()).toMatchObject({ reason: "replaced", retryable: false });
    const waiting = await until(
      () => channelStatus(app, channel),
      (value) => value.activeUploadId === "fresh-attempt",
    );
    expect(waiting.lastError).toBeUndefined();
    expect(await (await fetch(channel.downloadUrl, { signal: signal().signal })).text()).toBe("fresh");
    expect((await fresh).ok).toBe(true);

    const busy = await createChannel(app);
    const receiving = fetch(busy.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, busy),
      (value) => value.waitingReceivers === 1,
    );
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const streaming = fetch(busy.uploadUrl, {
      method: "PUT",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          input = controller;
          controller.enqueue(new TextEncoder().encode("first "));
        },
      }),
      headers: { "x-airshare-no-redirect": "1" },
      signal: signal().signal,
    });
    const reader = (await receiving).body!.getReader();
    await reader.read();
    const refused = await fetch(busy.uploadUrl, {
      method: "PUT",
      body: "second",
      headers: { "x-airshare-no-redirect": "1" },
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).reason).toBe("busy");
    input.enqueue(new TextEncoder().encode("half"));
    input.close();
    while (!(await reader.read()).done) {
      /* drain */
    }
    expect((await streaming).ok).toBe(true);
  });
  test("Wget's default form transport header does not replace advertised raw-file media type", async () => {
    const app = await server();
    const entered = await fetch(`${app.base}/xfr/raw.bin`, {
      method: "POST",
      body: "hello",
      redirect: "manual",
      headers: { "user-agent": "Wget/1.25.0", "content-type": "application/x-www-form-urlencoded" },
    });
    expect(entered.status).toBe(307);
    const download = fetch(entered.headers.get("x-airshare-download-url")!, { signal: signal().signal });
    const upload = fetch(entered.headers.get("location")!, {
      method: "POST",
      body: "hello",
      headers: {
        "user-agent": "Wget/1.25.0",
        "content-type": "application/x-www-form-urlencoded",
        "x-airshare-no-redirect": "1",
      },
    });
    const response = await download;
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(await response.text()).toBe("hello");
    expect((await upload).status).toBe(200);
  });

  test("an empty file completes as a zero-byte transfer", async () => {
    const app = await server();
    const channel = await createChannel(app, { filename: "empty.txt", contentLength: 0 });
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    const upload = await fetch(channel.uploadUrl, {
      method: "PUT",
      body: "",
      headers: { "x-airshare-file-size": "0", "x-airshare-no-redirect": "1" },
      signal: AbortSignal.timeout(3000),
    });
    expect(upload.status).toBe(200);
    const download = await downloading;
    expect(download.headers.get("content-length")).toBe("0");
    expect((await download.arrayBuffer()).byteLength).toBe(0);
    expect((await channelStatus(app, channel)).completedTransfers).toBe(1);
  });

  test("a chunked upload exceeding its advertised length cannot look like a truncated success", async () => {
    const app = await server();
    const channel = await createChannel(app, { filename: "mismatch.txt", contentLength: 5 });
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal })
      .then(async (response) => {
        try {
          await response.arrayBuffer();
          return response.ok ? "success" : "failed";
        } catch {
          return "failed";
        }
      })
      .catch(() => "failed");
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abcdef"));
        controller.close();
      },
    });
    const upload = await fetch(channel.uploadUrl, {
      method: "PUT",
      body: stream,
      headers: { "x-airshare-file-size": "5", "x-airshare-no-redirect": "1" },
      signal: AbortSignal.timeout(3000),
    });
    expect(upload.status).toBe(400);
    expect(await downloading).toBe("failed");
    expect((await channelStatus(app, channel)).completedTransfers).toBe(0);
  });

  test("deleting a channel terminates an active response and uploader", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        input = controller;
        controller.enqueue(new TextEncoder().encode("prefix"));
      },
    });
    const uploading = fetch(channel.uploadUrl, {
      method: "PUT",
      body,
      headers: { "x-airshare-no-redirect": "1" },
      signal: signal().signal,
    }).catch(() => null);
    const reader = (await downloading).body!.getReader();
    expect((await reader.read()).value!.length).toBeGreaterThan(0);
    expect((await fetch(`${app.base}/api/channels/${channel.id}`, { method: "DELETE" })).status).toBe(204);
    const ended = await Promise.race([
      reader.read().then(
        () => false,
        () => true,
      ),
      Bun.sleep(600).then(() => false),
    ]);
    expect(ended).toBe(true);
    try {
      input.close();
    } catch {}
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

  test("hostBound is accepted only as a boolean and is reported to owners, never to receivers", async () => {
    const app = await server();
    const invalid = await fetch(`${app.base}/api/channels`, {
      method: "POST",
      headers: jsonType,
      body: JSON.stringify({ hostBound: "yes" }),
    });
    expect(invalid.status).toBe(400);
    const plain = await createChannel(app);
    expect(plain.hostBound).toBe(false);
    const bound = await createChannel(app, { filename: "tab.txt", hostBound: true });
    expect(bound.hostBound).toBe(true);
    const receiverKey = new URL(bound.downloadUrl).pathname.split("/")[2];
    const receiver = (await (await fetch(`${app.base}/api/channels/${receiverKey}`)).json()) as any;
    expect(receiver.hostBound).toBeUndefined();
  });

  test("a deleted share answers 410 with its reason on every API route instead of 404", async () => {
    const app = await server();
    const channel = await createChannel(app, { filename: "gone.txt", contentLength: 4 });
    const senderKey = senderKeyOf(channel);
    const receiverKey = new URL(channel.downloadUrl).pathname.split("/")[2];
    const waiting = fetch(channel.downloadUrl, { signal: signal().signal });
    const events = sseReader(await fetch(channel.eventsUrl, { signal: signal().signal }));
    await events.next("status");
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    expect((await fetch(channel.deleteUrl, { method: "DELETE" })).status).toBe(204);
    const body = { error: "This share was deleted.", reason: "deleted" };
    const refused = await waiting;
    expect(refused.status).toBe(410);
    expect(await refused.json()).toEqual(body);
    expect((await events.next("closed")).data).toEqual(body);
    for (const url of [
      channel.statusUrl,
      `${app.base}/api/channels/${senderKey}`,
      `${app.base}/api/channels/${receiverKey}`,
      channel.eventsUrl,
      `${app.base}/api/channels/${receiverKey}/events`,
      channel.downloadUrl,
      `${app.base}/api/v1/channel/receiver/${receiverKey}`,
      `${app.base}/api/v1/channel/receiver/${receiverKey}/download/gone.txt`,
      `${app.base}/api/v1/channel/sender/${senderKey}`,
    ]) {
      const response = await fetch(url);
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual(body);
    }
    expect((await fetch(channel.downloadUrl, { method: "HEAD" })).status).toBe(410);
    expect(
      (await fetch(channel.uploadUrl, { method: "PUT", body: "data", headers: { "x-airshare-no-redirect": "1" } }))
        .status,
    ).toBe(410);
    expect((await fetch(channel.deleteUrl, { method: "DELETE" })).status).toBe(410);
    // A closed key still never answers for a different role, and unknown keys stay 404.
    expect((await fetch(`${app.base}/api/v1/channel/sender/${receiverKey}`)).status).toBe(404);
    expect((await fetch(`${app.base}/api/channels/${"0".repeat(32)}`)).status).toBe(404);
  });

  test("Station trackers receive a closed event with the role key and reason", async () => {
    const app = await server();
    const tracker = sseReader(await fetch(`${app.base}/api/v1/track`, { signal: signal().signal }));
    const trackerKey = (await tracker.next("tracker_event")).data.initialized.tracker_key;
    const created = await fetch(`${app.base}/api/v1/channel`, {
      method: "POST",
      headers: jsonType,
      body: JSON.stringify({
        tracker: { tracker_key: trackerKey, perspective: "channel" },
        file_details: { filename: "t.txt" },
      }),
    });
    const details = (await created.json()) as any;
    expect((await fetch(`${app.base}/api/channels/${details.keys.channel_key}`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await tracker.next("closed")).data).toEqual({
      id: details.keys.channel_key,
      key: { channel: details.keys.channel_key },
      error: "This share was deleted.",
      reason: "deleted",
    });
    await tracker.cancel();
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
    const forged = (await fetch(receiverStatus, { headers: { "x-airshare-sender-presence": "1" } }).then((response) =>
      response.json(),
    )) as any;
    expect(forged.senderOnline).toBe(false);
    const hosted = (await fetch(channel.statusUrl, { headers: { "x-airshare-sender-presence": "1" } }).then(
      (response) => response.json(),
    )) as any;
    expect(hosted.senderOnline).toBe(true);
    await fetch(channel.statusUrl, { headers: { "x-airshare-sender-presence": "0" } });
    expect((await channelStatus(app, channel)).senderOnline).toBe(false);
    const hostingController = signal();
    const hosting = sseReader(await fetch(`${channel.eventsUrl}?hosting=1`, { signal: hostingController.signal }));
    expect((await hosting.next("status")).data.senderOnline).toBe(true);
    await hosting.cancel();
    hostingController.abort();
    await until(
      () => channelStatus(app, channel),
      (value) => !value.senderOnline,
    );
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
    const next = await until(
      async () => fetch(`${app.base}/api/v1/track`, { signal: signal().signal }),
      (response) => response.status === 200,
    );
    await next.body!.cancel();
  });

  test("regular CLI upload replays its sender URL after a successful delivery", async () => {
    const app = await server();
    const channel = await createChannel(app, { filename: "repeat.txt", contentLength: 5 });
    for (let index = 0; index < 2; index++) {
      const downloading = fetch(channel.downloadUrl, { signal: signal().signal }).then((response) => response.text());
      await until(
        () => channelStatus(app, channel),
        (value) => value.waitingReceivers === 1,
      );
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
    const upload = fetch(channel.uploadUrl, {
      method: "PUT",
      body: "hello",
      headers: { "x-airshare-no-redirect": "1" },
      signal: controller.signal,
    }).catch(() => null);
    await until(
      () => channelStatus(app, channel),
      (value) => value.activeUpload,
    );
    controller.abort();
    await upload;
    const status = await until(
      () => channelStatus(app, channel),
      (value) => !value.activeUpload,
    );
    expect(status.completedTransfers).toBe(0);
    expect(status.waitingReceivers).toBe(0);
  });

  test("disconnecting all active receivers stops reading an unfinished upload", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const downloadController = signal();
    const downloading = fetch(channel.downloadUrl, { signal: downloadController.signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        input = controller;
        controller.enqueue(new TextEncoder().encode("prefix"));
      },
    });
    const uploadController = signal();
    const upload = fetch(channel.uploadUrl, {
      method: "PUT",
      body,
      headers: { "x-airshare-no-redirect": "1" },
      signal: uploadController.signal,
    }).catch(() => null);
    const reader = (await downloading).body!.getReader();
    expect((await reader.read()).value!.byteLength).toBe(6);
    downloadController.abort();
    const status = await until(
      () => channelStatus(app, channel),
      (value) => !value.activeUpload,
    );
    expect(status.completedTransfers).toBe(0);
    try {
      input.close();
    } catch {}
    uploadController.abort();
    await upload;
  });

  test("partial bodies and extra trailing chunks fail after download headers are sent", async () => {
    const app = await server();
    for (const initial of ["abc", "abcde"]) {
      const channel = await createChannel(app, { filename: "five.txt", contentLength: 5 });
      const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
      await until(
        () => channelStatus(app, channel),
        (value) => value.waitingReceivers === 1,
      );
      let input!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          input = controller;
          controller.enqueue(new TextEncoder().encode(initial));
        },
      });
      const uploading = fetch(channel.uploadUrl, {
        method: "PUT",
        body,
        headers: { "x-airshare-no-redirect": "1", "x-airshare-file-size": "5" },
        signal: signal().signal,
      });
      const response = await downloading;
      const reader = response.body!.getReader();
      expect((await reader.read()).value!.byteLength).toBe(initial.length === 5 ? 4 : 3);
      if (initial.length === 5) input.enqueue(new TextEncoder().encode("f"));
      input.close();
      expect((await uploading).status).toBe(400);
      expect(
        await reader.read().then(
          () => false,
          () => true,
        ),
      ).toBe(true);
      expect((await channelStatus(app, channel)).completedTransfers).toBe(0);
    }
  });

  test("a receiver arriving mid-transfer waits for the next complete upload", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const firstDownload = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        input = controller;
        controller.enqueue(new TextEncoder().encode("first-"));
      },
    });
    const firstUpload = fetch(channel.uploadUrl, {
      method: "PUT",
      body,
      headers: { "x-airshare-no-redirect": "1" },
      signal: signal().signal,
    });
    const firstReader = (await firstDownload).body!.getReader();
    expect(new TextDecoder().decode((await firstReader.read()).value)).toBe("first-");
    const secondDownload = fetch(channel.downloadUrl, { signal: signal().signal }).then((response) => response.text());
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1 && value.activeUpload,
    );
    input.enqueue(new TextEncoder().encode("done"));
    input.close();
    let rest = "";
    while (true) {
      const result = await firstReader.read();
      if (result.done) break;
      rest += new TextDecoder().decode(result.value);
    }
    expect(rest).toBe("done");
    expect((await firstUpload).status).toBe(200);
    expect((await channelStatus(app, channel)).waitingReceivers).toBe(1);
    const secondUpload = await fetch(channel.uploadUrl, {
      method: "PUT",
      body: "first-done",
      headers: { "x-airshare-no-redirect": "1", "x-airshare-file-size": "10" },
    });
    expect(secondUpload.status).toBe(200);
    expect(await secondDownload).toBe("first-done");
    expect((await channelStatus(app, channel)).completedTransfers).toBe(2);
  });

  test("a receiver that never takes its first bytes is dropped after the first-byte timeout, but a proven one may pause longer", async () => {
    // A connected client that stops reading still acknowledges into its kernel buffers, several MiB on Linux
    // loopback. A 1 MiB queue makes the first-byte window 16 MiB, beyond what those buffers can take.
    const app = await server({
      RECEIVER_FIRST_BYTE_TIMEOUT_MS: "300",
      RECEIVER_STALL_TIMEOUT_MS: "60000",
      STREAM_HIGH_WATER_MARK: String(1024 * 1024),
    });
    const total = 48 * 1024 * 1024;
    const channel = await createChannel(app, { filename: "first-byte.bin", contentLength: total });
    const url = new URL(channel.downloadUrl);
    // Like a receiver whose network vanished while it waited: connected, but never reading.
    const dead = connect({ host: "127.0.0.1", port: Number(url.port) });
    dead.on("error", () => {});
    dead.pause();
    await new Promise<void>((resolve) => dead.once("connect", resolve));
    dead.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
    // A live receiver that pauses well past the first-byte timeout once it is past the window.
    const pausing = fetch(channel.downloadUrl, { signal: signal().signal }).then(async (response) => {
      const reader = response.body!.getReader();
      let count = 0;
      let paused = false;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        count += result.value.byteLength;
        if (!paused && count >= 24 * 1024 * 1024) {
          paused = true;
          await Bun.sleep(1200);
        }
      }
      return count;
    });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 2,
    );
    let remaining = total;
    const chunk = new Uint8Array(65_536).fill(7);
    const body = new ReadableStream({
      pull(controller) {
        if (!remaining) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        remaining -= chunk.length;
      },
    });
    const started = Date.now();
    const uploading = fetch(channel.uploadUrl, {
      method: "PUT",
      body,
      headers: { "content-length": String(total), "x-airshare-no-redirect": "1" },
      signal: signal().signal,
    });
    try {
      const dropped = await until(
        () => channelStatus(app, channel),
        (value) => value.activeReceivers === 1,
        5000,
      );
      expect(dropped.activeReceivers).toBe(1);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await pausing).toBe(total);
      expect(await (await uploading).json()).toMatchObject({ succeeded: { receiver_count: 1, bytes_sent: total } });
    } finally {
      dead.destroy();
    }
  }, 15_000);

  test("deleting a share while a receiver still drains the end of an upload reports the deletion, not success", async () => {
    // A queue larger than the file lets every byte be relayed while one receiver has read none of them.
    const app = await server({ STREAM_HIGH_WATER_MARK: String(8 * 1024 * 1024) });
    const size = 4 * 1024 * 1024;
    const channel = await createChannel(app, { filename: "drain.bin", contentLength: size });
    const fast = fetch(channel.downloadUrl, { signal: signal().signal }).then(
      async (response) => (await response.arrayBuffer()).byteLength,
    );
    const url = new URL(channel.downloadUrl);
    const slow = connect({ host: "127.0.0.1", port: Number(url.port) });
    slow.on("error", () => {});
    slow.pause();
    await new Promise<void>((resolve) => slow.once("connect", resolve));
    slow.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
    try {
      await until(
        () => channelStatus(app, channel),
        (value) => value.waitingReceivers === 2,
      );
      const uploading = fetch(channel.uploadUrl, {
        method: "PUT",
        body: new Uint8Array(size),
        headers: { "x-airshare-no-redirect": "1" },
      });
      expect(await fast).toBe(size);
      await until(
        () => channelStatus(app, channel),
        (value) => value.activeReceivers === 1 && value.bytesTransferred === size,
      );
      expect((await fetch(channel.deleteUrl, { method: "DELETE" })).status).toBe(204);
      const answer = await uploading;
      expect(answer.status).toBe(410);
      expect(await answer.json()).toMatchObject({
        reason: "deleted",
        failed: { reason: "deleted", bytes_sent: size, receiver_count: 1 },
      });
    } finally {
      slow.destroy();
    }
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
      const reader = response.body!.getReader();
      let count = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        count += result.value.byteLength;
      }
      return count;
    });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 2,
    );
    let remaining = total;
    const chunk = new Uint8Array(65_536).fill(37);
    const body = new ReadableStream({
      pull(controller) {
        if (!remaining) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        remaining -= chunk.length;
      },
    });
    const uploadController = signal();
    const uploading = fetch(channel.uploadUrl, {
      method: "PUT",
      body,
      headers: { "content-length": String(total), "x-airshare-no-redirect": "1" },
      signal: uploadController.signal,
    }).catch(() => null);
    try {
      const result = await Promise.race([receiving, Bun.sleep(2000).then(() => -1)]);
      expect(result).toBe(total);
      expect((await uploading)!.status).toBe(200);
      expect((await channelStatus(app, channel)).completedTransfers).toBe(1);
    } finally {
      stalled.destroy();
      uploadController.abort();
    }
  });

  test("uploads above 128 MiB are relayed with matching streaming hashes", async () => {
    const app = await server();
    const total = 129 * 1024 * 1024;
    const channel = await createChannel(app, { filename: "large.bin", contentLength: total });
    const inputHash = new Bun.CryptoHasher("sha256");
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal }).then(async (response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(total));
      const hash = new Bun.CryptoHasher("sha256");
      let size = 0;
      const reader = response.body!.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        hash.update(chunk.value);
      }
      return { size, hash: hash.digest("hex") };
    });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    let remaining = total;
    const chunk = new Uint8Array(65_536).fill(0x5a);
    const body = new ReadableStream({
      pull(controller) {
        if (!remaining) {
          controller.close();
          return;
        }
        inputHash.update(chunk);
        controller.enqueue(chunk);
        remaining -= chunk.length;
      },
    });
    const uploading = fetch(channel.uploadUrl, {
      method: "PUT",
      body,
      headers: { "content-length": String(total), "x-airshare-no-redirect": "1" },
      signal: signal().signal,
    });
    const result = await downloading;
    expect((await uploading).status).toBe(200);
    expect(result.size).toBe(total);
    expect(result.hash).toBe(inputHash.digest("hex"));
  }, 20_000);
});

describe("metadata lifetime", () => {
  test("a client's used-channel quota survives restart and releases on deletion", async () => {
    const dir = await temporaryDataDir();
    const env = {
      DATA_DIR: dir.path,
      MAX_CHANNELS_PER_CLIENT: "1",
      CHANNEL_CREATION_BURST: "0",
      TRUSTED_PROXIES: "127.0.0.1",
    };
    let active = await server(env);
    try {
      const channel = await createChannel(active, { contentLength: 0 });
      const receiving = fetch(channel.downloadUrl, { signal: signal().signal });
      await until(
        () => channelStatus(active, channel),
        (value) => value.waitingReceivers === 1,
      );
      expect(
        (await fetch(channel.uploadUrl, { method: "PUT", body: "", headers: { "x-airshare-no-redirect": "1" } }))
          .status,
      ).toBe(200);
      await (await receiving).arrayBuffer();
      await active.close();
      servers.splice(servers.indexOf(active), 1);
      active = await server(env);
      expect((await channelStatus(active, channel)).completedTransfers).toBe(1);
      const blocked = await fetch(`${active.base}/api/channels`, { method: "POST", headers: jsonType, body: "{}" });
      expect(blocked.status).toBe(429);
      expect(((await blocked.json()) as any).reason).toBe("channel_quota");
      expect(
        (
          await fetch(`${active.base}/api/channels`, {
            method: "POST",
            body: "{}",
            headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.99" },
          })
        ).status,
      ).toBe(201);
      expect((await fetch(`${active.base}/api/channels/${channel.id}`, { method: "DELETE" })).status).toBe(204);
      expect(
        (await fetch(`${active.base}/api/channels`, { method: "POST", headers: jsonType, body: "{}" })).status,
      ).toBe(201);
    } finally {
      if (servers.includes(active)) {
        await active.close();
        servers.splice(servers.indexOf(active), 1);
      }
      await dir.remove();
    }
  });

  test("creation admission covers every entry route and ignores spoofed forwarding headers by default", async () => {
    const app = await server({
      CHANNEL_CREATION_BURST: "2",
      CHANNEL_CREATION_INTERVAL_MS: "60000",
      TRUSTED_PROXIES: "",
    });
    await createChannel(app);
    expect((await fetch(`${app.base}/xfr?prepare=1`, { method: "POST", redirect: "manual" })).status).toBe(201);
    for (const [path, method, body] of [
      ["/api/channels", "POST", "{}"],
      ["/api/v1/channel", "POST", "{}"],
      ["/xfr", "GET", undefined],
      ["/file.txt", "PUT", "data"],
      ["/", "GET", undefined],
    ] as const) {
      const response = await fetch(`${app.base}${path}`, {
        method,
        body,
        redirect: "manual",
        headers: {
          ...jsonType,
          "user-agent": "curl/8.21.0",
          "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
        },
      });
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    }
  });

  test("explicit proxy trust selects the nearest untrusted client and groups IPv6 client prefixes", async () => {
    const app = await server({
      CHANNEL_CREATION_BURST: "1",
      CHANNEL_CREATION_INTERVAL_MS: "60000",
      TRUSTED_PROXIES: "127.0.0.1,10.0.0.0/8",
    });
    const create = (forwarded: string) =>
      fetch(`${app.base}/api/channels`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json", "x-forwarded-for": forwarded },
      });
    expect((await create("198.51.100.1, 203.0.113.1, 10.1.1.1")).status).toBe(201);
    expect((await create("198.51.100.2, 203.0.113.1, 10.1.1.1")).status).toBe(429);
    expect((await create("203.0.113.2")).status).toBe(201);
    expect((await create("2001:db8:1:2::1")).status).toBe(201);
    expect((await create("2001:db8:1:2::abcd")).status).toBe(429);
    expect((await create("2001:db8:1:3::1")).status).toBe(201);
  });

  test("a forwarded address with a port or an IPv6 zone still names its own client", async () => {
    const app = await server({
      CHANNEL_CREATION_BURST: "1",
      CHANNEL_CREATION_INTERVAL_MS: "60000",
      TRUSTED_PROXIES: "127.0.0.1",
    });
    const create = (header: string, value: string) =>
      fetch(`${app.base}/api/channels`, {
        method: "POST",
        body: "{}",
        headers: { ...jsonType, [header]: value },
      }).then((response) => response.status);
    expect(await create("x-forwarded-for", "fe80::1%eth0")).toBe(201);
    expect(await create("x-forwarded-for", "fe80::2%eth1")).toBe(429);
    expect(await create("x-forwarded-for", "203.0.113.7:4321")).toBe(201);
    expect(await create("x-forwarded-for", "203.0.113.7:5555")).toBe(429);
    expect(await create("x-forwarded-for", "203.0.113.7")).toBe(429);
    // Another client behind the same proxy keeps a bucket of its own.
    expect(await create("x-forwarded-for", "198.51.100.3:80")).toBe(201);
    expect(await create("x-forwarded-for", "[2001:db8:5::1]:443")).toBe(201);
    expect(await create("x-forwarded-for", "2001:db8:5::2")).toBe(429);
    expect(await create("x-real-ip", "192.0.2.44:1234")).toBe(201);
    expect(await create("x-real-ip", "192.0.2.44")).toBe(429);
  });

  test("a malformed or overlong X-Forwarded-For prefix still resolves to the nearest valid untrusted hop", async () => {
    const app = await server({
      CHANNEL_CREATION_BURST: "1",
      CHANNEL_CREATION_INTERVAL_MS: "60000",
      TRUSTED_PROXIES: "127.0.0.1,10.0.0.0/8",
    });
    const create = (forwarded: string) =>
      fetch(`${app.base}/api/channels`, {
        method: "POST",
        body: "{}",
        headers: { ...jsonType, "x-forwarded-for": forwarded },
      }).then((r) => r.status);
    expect(await create("not-an-ip, 203.0.113.5")).toBe(201);
    // Each malformed header gets its client's own bucket, not one shared with the proxy.
    expect(await create("junk, 198.51.100.8, 10.2.2.2")).toBe(201);
    expect(await create("198.51.100.8")).toBe(429);
    expect(
      await create([...Array.from({ length: 40 }, (_, index) => `192.0.2.${index + 1}`), "198.51.100.9"].join(", ")),
    ).toBe(201);
    expect(await create("198.51.100.9")).toBe(429);
    // A malformed hop right next to the proxies leaves no client to name, so the request counts against the proxy.
    expect(await create("203.0.113.77, garbage")).toBe(201);
    expect(await create("203.0.113.78, garbage")).toBe(429);
  });

  test("an untrusted bridge gateway cannot rotate its bucket with forged forwarding prefixes", async () => {
    const app = await server({
      CHANNEL_CREATION_BURST: "2",
      CHANNEL_CREATION_INTERVAL_MS: "60000",
      TRUSTED_PROXIES: "127.0.0.1",
    });
    const create = (forwarded: string) =>
      fetch(`${app.base}/api/channels`, {
        method: "POST",
        body: "{}",
        headers: { ...jsonType, "x-forwarded-for": forwarded },
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
    const evicted = await fetch(`${app.base}/api/channels/${unused.id}`);
    expect(evicted.status).toBe(410);
    expect(await evicted.json()).toEqual({ error: "This share expired.", reason: "expired" });
    expect((await fetch(`${app.base}/api/channels/${protectedChannel.id}`)).status).toBe(200);
    expect((await fetch(`${app.base}/api/channels/${replacement.id}`)).status).toBe(200);
    const anotherHosting = sseReader(await fetch(`${replacement.eventsUrl}?hosting=1`, { signal: signal().signal }));
    await anotherHosting.next("status");
    expect((await fetch(`${app.base}/api/channels`, { method: "POST", headers: jsonType, body: "{}" })).status).toBe(
      503,
    );
    await hosting.cancel();
    await anotherHosting.cancel();
  });

  test("receiver status polling cannot retain an unused channel, while a waiting receiver is protected", async () => {
    const app = await server({ UNUSED_CHANNEL_TTL_MS: "120", CHANNEL_TTL_MS: "60000", CLEANUP_INTERVAL_MS: "20" });
    const unused = await createChannel(app);
    const receiverKey = new URL(unused.downloadUrl).pathname.split("/")[2];
    const response = await until(
      () => fetch(`${app.base}/api/channels/${receiverKey}`),
      (value) => value.status === 410,
      1200,
    );
    expect(((await response.json()) as any).reason).toBe("expired");
    const waiting = await createChannel(app);
    const downloading = fetch(waiting.downloadUrl, { signal: signal().signal });
    void downloading.catch(() => {});
    await until(
      () => channelStatus(app, waiting),
      (value) => value.waitingReceivers === 1,
    );
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
    await hosting.cancel();
    first.abort();
    const second = signal();
    const reconnect = await fetch(`${channel.eventsUrl}?hosting=1`, { signal: second.signal });
    expect(reconnect.status).toBe(200);
    const connected = sseReader(reconnect);
    expect((await connected.next("status")).data.senderOnline).toBe(true);
    await connected.cancel();
    second.abort();
    const expired = await until(
      () => fetch(channel.statusUrl),
      (response) => response.status === 410,
      1200,
    );
    expect(((await expired.json()) as any).reason).toBe("expired");
  });

  test("an eager creation body keeps its channel alive until the initial redirect request finishes", async () => {
    const app = await server({ UNUSED_CHANNEL_TTL_MS: "120", CHANNEL_TTL_MS: "60000", CLEANUP_INTERVAL_MS: "20" });
    const base = new URL(app.base);
    const socket = connect(Number(base.port), "127.0.0.1");
    socket.on("error", () => {});
    let wire = "";
    const headers = new Promise<string>((resolve) =>
      socket.on("data", (value) => {
        wire += value.toString();
        if (wire.includes("\r\n\r\n")) resolve(wire);
      }),
    );
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    try {
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(
        `POST /xfr/slow.bin HTTP/1.1\r\nHost: ${base.host}\r\nContent-Length: 10\r\nConnection: close\r\n\r\n12345`,
      );
      const uploadUrl = (await headers).match(/^x-airshare-upload-url: (.+)$/im)![1]!.trim();
      const status = senderStatusOf(uploadUrl);
      await Bun.sleep(180);
      expect((await fetch(status)).status).toBe(200);
      socket.write("67890");
      await closed;
      expect((await fetch(status)).status).toBe(200);
    } finally {
      socket.destroy();
    }
  });

  test("per-client receiver and subscriber quotas recover after cancellation", async () => {
    const app = await server({ MAX_RECEIVERS_PER_CLIENT: "1", MAX_SUBSCRIBERS_PER_CLIENT: "1" });
    const first = await createChannel(app);
    const second = await createChannel(app);
    const receiver = signal();
    const waiting = fetch(first.downloadUrl, { signal: receiver.signal }).catch(() => null);
    await until(
      () => channelStatus(app, first),
      (value) => value.waitingReceivers === 1,
    );
    expect((await fetch(second.downloadUrl, { signal: AbortSignal.timeout(500) })).status).toBe(429);
    receiver.abort();
    await waiting;
    await until(
      () => channelStatus(app, first),
      (value) => value.waitingReceivers === 0,
    );
    const connection = signal();
    const events = sseReader(await fetch(first.eventsUrl, { signal: connection.signal }));
    await events.next("status");
    expect((await fetch(second.eventsUrl, { signal: AbortSignal.timeout(500) })).status).toBe(429);
    await events.cancel();
    connection.abort();
    const next = await until(
      () => fetch(second.eventsUrl, { signal: signal().signal }),
      (response) => response.status === 200,
    );
    await next.body!.cancel();
  });

  test("MAX_UPLOADS_PER_CLIENT caps one client's concurrent uploads without disturbing the ones already waiting", async () => {
    const app = await server({ MAX_UPLOADS_PER_CLIENT: "2" });
    const [a, b, c] = [await createChannel(app), await createChannel(app), await createChannel(app)];
    const waiting = (channel: any) => {
      const controller = signal();
      const response = fetch(channel.uploadUrl, {
        method: "PUT",
        body: "abc",
        headers: { "x-airshare-no-redirect": "1" },
        signal: controller.signal,
      }).catch(() => null);
      return { controller, response };
    };
    const first = waiting(a);
    const second = waiting(b);
    await until(
      async () => [await channelStatus(app, a), await channelStatus(app, b)],
      ([x, y]) => x.activeUpload && y.activeUpload,
    );
    const refused = await fetch(c.uploadUrl, {
      method: "PUT",
      body: "abc",
      headers: { "x-airshare-no-redirect": "1" },
    });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ reason: "upload_limit" });
    expect(refused.headers.get("retry-after")).toBe("1");
    // A refused re-upload to a channel doesn't replace that channel's waiting upload.
    expect(
      (await fetch(a.uploadUrl, { method: "PUT", body: "xyz", headers: { "x-airshare-no-redirect": "1" } })).status,
    ).toBe(429);
    const downloaded = fetch(a.downloadUrl).then((r) => r.text());
    expect(await downloaded).toBe("abc");
    expect((await first.response)?.status).toBe(200);
    // The finished upload's slot is free again.
    const third = waiting(c);
    expect(await fetch(c.downloadUrl).then((r) => r.text())).toBe("abc");
    expect((await third.response)?.status).toBe(200);
    second.controller.abort();
    await second.response;
  });
  test("channel metadata survives restart from a live sender while volatile presence and uploads reset", async () => {
    const dir = await temporaryDataDir();
    try {
      const first = await server({ DATA_DIR: dir.path });
      const channel = await createChannel(first, { filename: "remembered.txt", contentLength: 7 });
      const hosting = sseReader(await fetch(`${channel.eventsUrl}?hosting=1`, { signal: signal().signal }));
      await hosting.next("status");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("rem"));
        },
      });
      void fetch(channel.uploadUrl, {
        method: "PUT",
        body,
        headers: { "x-airshare-no-redirect": "1" },
        signal: signal().signal,
      }).catch(() => null);
      const live = await until(
        () => channelStatus(first, channel),
        (value) => value.activeUpload && value.senderOnline,
      );
      expect(live.activeUpload).toBe(true);
      await first.close();
      servers.splice(servers.indexOf(first), 1);
      const second = await server({ DATA_DIR: dir.path });
      const response = await fetch(`${second.base}/api/channels/${channel.id}`);
      expect(response.status).toBe(200);
      const restored = (await response.json()) as any;
      expect(restored.file).toEqual({
        filename: "remembered.txt",
        contentType: "application/octet-stream",
        contentLength: 7,
      });
      expect(restored.senderOnline).toBe(false);
      expect(restored.activeUpload).toBe(false);
      expect(restored.waitingReceivers).toBe(0);
      await second.close();
      servers.splice(servers.indexOf(second), 1);
    } finally {
      await dir.remove();
    }
  });

  test("creation at a channel limit still sweeps expired channels first, without waiting for the interval sweep", async () => {
    for (const limit of [{ MAX_CHANNELS_PER_CLIENT: "1" }, { MAX_CHANNELS: "1" }] as Record<string, string>[]) {
      const app = await server({
        ...limit,
        UNUSED_CHANNEL_TTL_MS: "200",
        CLEANUP_INTERVAL_MS: "3600000",
        CHANNEL_CREATION_BURST: "0",
      });
      const old = await createChannel(app);
      await Bun.sleep(300);
      const fresh = await createChannel(app);
      expect(fresh.id).not.toBe(old.id);
      expect((await fetch(old.statusUrl)).status, JSON.stringify(limit)).toBe(410);
    }
  });

  test("deleted and expired keys stay dead after a restart and their creator quota stays released", async () => {
    const dir = await temporaryDataDir();
    const env = {
      DATA_DIR: dir.path,
      UNUSED_CHANNEL_TTL_MS: "300",
      CLEANUP_INTERVAL_MS: "25",
      MAX_CHANNELS_PER_CLIENT: "2",
      CHANNEL_CREATION_BURST: "0",
    };
    try {
      const first = await server(env);
      const deleted = await createChannel(first);
      const expiring = await createChannel(first);
      const hosting = sseReader(await fetch(`${deleted.eventsUrl}?hosting=1`, { signal: signal().signal }));
      await hosting.next("status");
      expect((await fetch(deleted.deleteUrl, { method: "DELETE" })).status).toBe(204);
      const expired = await until(
        () => fetch(`${first.base}/api/channels/${expiring.id}`),
        (response) => response.status === 410,
        2000,
      );
      expect(((await expired.json()) as any).reason).toBe("expired");
      await first.close();
      servers.splice(servers.indexOf(first), 1);
      const second = await server(env);
      for (const channel of [deleted, expiring]) {
        for (const key of [channel.id, senderKeyOf(channel), receiverKeyOf(channel)])
          expect((await fetch(`${second.base}/api/channels/${key}`)).status).toBe(404);
        expect((await fetch(`${second.base}/download/${receiverKeyOf(channel)}/file`)).status).toBe(404);
        expect((await fetch(`${second.base}/api/v1/channel/sender/${senderKeyOf(channel)}`)).status).toBe(404);
      }
      await createChannel(second);
      await createChannel(second);
      await second.close();
      servers.splice(servers.indexOf(second), 1);
    } finally {
      await dir.remove();
    }
  });

  test("a graceful shutdown records hosting activity so a hosted channel survives an immediate restart", async () => {
    const dir = await temporaryDataDir();
    const env = {
      DATA_DIR: dir.path,
      CHANNEL_TTL_MS: "600",
      UNUSED_CHANNEL_TTL_MS: "30000",
      CLEANUP_INTERVAL_MS: "60000",
    };
    try {
      const first = await startServer(env, { graceful: true });
      servers.push(first);
      const hosted = await createChannel(first);
      const idle = await createChannel(first);
      const hosting = sseReader(await fetch(`${hosted.eventsUrl}?hosting=1`, { signal: signal().signal }));
      await hosting.next("status");
      await Bun.sleep(900);
      await first.close();
      servers.splice(servers.indexOf(first), 1);
      const second = await server(env);
      const restored = await fetch(`${second.base}/api/channels/${hosted.id}`);
      expect(restored.status).toBe(200);
      const state = (await restored.json()) as any;
      expect(state.senderOnline).toBe(false);
      expect(state.activeUpload).toBe(false);
      expect((await fetch(`${second.base}/api/channels/${idle.id}`)).status).toBe(404);
      await second.close();
      servers.splice(servers.indexOf(second), 1);
    } finally {
      await dir.remove();
    }
  });
  test("never-used terminal and API channels wait an hour by default, also in the Compose deployment", async () => {
    const { config } = await import("../src/config");
    if (Bun.env.UNUSED_CHANNEL_TTL_MS === undefined) expect(config.unusedChannelTtl).toBe(3_600_000);
    const compose = await Bun.file(new URL("../compose.yaml", import.meta.url)).text();
    expect(compose).toContain("UNUSED_CHANNEL_TTL_MS: ${UNUSED_CHANNEL_TTL_MS:-3600000}");
    expect(compose).toContain("HOST_GRACE_MS: ${HOST_GRACE_MS:-20000}");
  });
  test("channel capacity and idle expiration bound persisted state", async () => {
    const app = await server({ MAX_CHANNELS: "1", CHANNEL_TTL_MS: "120", CLEANUP_INTERVAL_MS: "20" });
    const channel = await createChannel(app, { contentLength: 0 });
    const download = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    expect(
      (await fetch(channel.uploadUrl, { method: "PUT", body: "", headers: { "x-airshare-no-redirect": "1" } })).status,
    ).toBe(200);
    await (await download).arrayBuffer();
    expect((await fetch(`${app.base}/api/channels`, { method: "POST", headers: jsonType, body: "{}" })).status).toBe(
      503,
    );
    await Bun.sleep(180);
    expect((await fetch(`${app.base}/api/channels/${channel.id}`)).status).toBe(410);
    expect((await fetch(`${app.base}/api/channels`, { method: "POST", headers: jsonType, body: "{}" })).status).toBe(
      201,
    );
  });

  test("an active transfer is never expired by the idle metadata timer", async () => {
    const app = await server({ CHANNEL_TTL_MS: "120", CLEANUP_INTERVAL_MS: "20" });
    const channel = await createChannel(app);
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        input = controller;
        controller.enqueue(new TextEncoder().encode("prefix"));
      },
    });
    const uploading = fetch(channel.uploadUrl, {
      method: "PUT",
      body,
      headers: { "x-airshare-no-redirect": "1" },
      signal: signal().signal,
    });
    const reader = (await downloading).body!.getReader();
    await reader.read();
    await Bun.sleep(180);
    expect((await channelStatus(app, channel)).activeUpload).toBe(true);
    input.close();
    expect((await reader.read()).done).toBe(true);
    expect((await uploading).status).toBe(200);
  });
});

describe("host-bound lifecycle", () => {
  const left = { error: "The sender stopped sharing this file.", reason: "sender_left" };
  const statusOf = (base: string, key: string) => fetch(`${base}/api/channels/${key}`);

  test("a host-bound share closes as sender_left one grace period after its hosting stream ends", async () => {
    const app = await server({ HOST_GRACE_MS: "400", MAX_CHANNELS_PER_CLIENT: "1", CHANNEL_CREATION_BURST: "0" });
    const channel = await createChannel(app, { filename: "tab.bin", hostBound: true });
    const host = signal();
    const hosting = sseReader(await fetch(`${channel.eventsUrl}?hosting=1`, { signal: host.signal }));
    expect((await hosting.next("status")).data.senderOnline).toBe(true);
    const observer = sseReader(await fetch(channel.eventsUrl, { signal: signal().signal }));
    await observer.next("status");
    const waiting = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    expect((await fetch(`${app.base}/api/channels`, { method: "POST", headers: jsonType, body: "{}" })).status).toBe(
      429,
    );
    await hosting.cancel();
    host.abort();
    const leftAt = Date.now();
    await Bun.sleep(150);
    expect((await channelStatus(app, channel)).waitingReceivers).toBe(1);
    const refused = await waiting;
    const elapsed = Date.now() - leftAt;
    expect(refused.status).toBe(410);
    expect(await refused.json()).toEqual(left);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2000);
    expect((await observer.next("closed")).data).toEqual(left);
    for (const key of [channel.id, senderKeyOf(channel), receiverKeyOf(channel)]) {
      const response = await statusOf(app.base, key);
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual(left);
    }
    expect((await fetch(channel.downloadUrl)).status).toBe(410);
    // The creator's quota is released with the channel.
    expect((await fetch(`${app.base}/api/channels`, { method: "POST", headers: jsonType, body: "{}" })).status).toBe(
      201,
    );
  });

  test("a tab that reconnects within the grace period keeps its share", async () => {
    const app = await server({ HOST_GRACE_MS: "500" });
    const channel = await createChannel(app, { hostBound: true });
    const first = signal();
    const hosting = sseReader(await fetch(`${channel.eventsUrl}?hosting=1`, { signal: first.signal }));
    await hosting.next("status");
    await hosting.cancel();
    first.abort();
    await Bun.sleep(250);
    const second = signal();
    const again = sseReader(await fetch(`${channel.eventsUrl}?hosting=1`, { signal: second.signal }));
    expect((await again.next("status")).data.senderOnline).toBe(true);
    await Bun.sleep(800);
    expect((await channelStatus(app, channel)).senderOnline).toBe(true);
    await again.cancel();
    second.abort();
    const closed = await until(
      () => fetch(channel.statusUrl),
      (response) => response.status === 410,
      2500,
    );
    expect(await closed.json()).toEqual(left);
  });

  test("a host-bound share whose tab never connects closes, while terminal and API channels are not host-bound", async () => {
    const app = await server({ HOST_GRACE_MS: "200" });
    const bound = await createChannel(app, { hostBound: true });
    const plain = await createChannel(app);
    const prepared = await fetch(`${app.base}/xfr/prepared.bin?prepare=1`, { method: "POST" });
    expect(prepared.status).toBe(201);
    const preparedStatus = senderStatusOf((await prepared.text()).trim());
    const receiving = await fetch(`${app.base}/xfr`, { redirect: "manual", headers: { "user-agent": "curl/8.21.0" } });
    expect(receiving.status).toBe(307);
    const receiverFirst = `${app.base}/api/channels/${new URL(receiving.headers.get("location")!).pathname.split("/")[2]}`;
    const closed = await until(
      () => fetch(bound.statusUrl),
      (response) => response.status === 410,
      1500,
    );
    expect(await closed.json()).toEqual(left);
    await Bun.sleep(300);
    for (const url of [plain.statusUrl, preparedStatus, receiverFirst]) expect((await fetch(url)).status).toBe(200);
  });

  test("presence leases keep a host-bound share and every availability change is pushed without repeating renewals", async () => {
    const app = await server({ HOST_GRACE_MS: "300", SENDER_LEASE_MS: "400" });
    const channel = await createChannel(app, { hostBound: true });
    const observer = sseReader(await fetch(channel.eventsUrl, { signal: signal().signal }));
    expect((await observer.next("status")).data.senderOnline).toBe(false);
    const tracker = sseReader(await fetch(`${app.base}/api/v1/track?format=native`, { signal: signal().signal }));
    const trackerKey = (await tracker.next("tracker_event")).data.initialized.tracker_key;
    expect(
      (await fetch(`${app.base}/api/channels/${receiverKeyOf(channel)}/subscribe/${trackerKey}`, { method: "POST" }))
        .status,
    ).toBe(200);
    const availability = async () => (await tracker.next("status")).data.senderOnline;
    expect(await availability()).toBe(false);
    // The subscription itself also announced the current (offline) state.
    expect((await observer.next("status")).data.senderOnline).toBe(false);
    const renew = () => fetch(channel.statusUrl, { headers: { "x-airshare-sender-presence": "1" } });
    await renew();
    expect((await observer.next("status")).data.senderOnline).toBe(true);
    expect(await availability()).toBe(true);
    for (let index = 0; index < 6; index += 1) {
      await Bun.sleep(100);
      await renew();
    }
    expect((await channelStatus(app, channel)).senderOnline).toBe(true);
    // Renewals were silent, so the next pushed status is the lease expiry.
    expect((await observer.next("status")).data.senderOnline).toBe(false);
    expect(await availability()).toBe(false);
    expect((await observer.next("closed")).data).toEqual(left);
    expect((await tracker.next("closed")).data).toEqual({
      id: receiverKeyOf(channel),
      key: { receiver: receiverKeyOf(channel) },
      ...left,
    });
  });
  test("the owner DELETE with reason=sender_left closes the share as sender_left", async () => {
    const app = await server();
    const channel = await createChannel(app, { hostBound: true });
    const hosting = sseReader(await fetch(`${channel.eventsUrl}?hosting=1`, { signal: signal().signal }));
    await hosting.next("status");
    const waiting = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    for (const reason of ["deleted", "expired", "bogus", ""])
      expect((await fetch(`${channel.deleteUrl}?reason=${reason}`, { method: "DELETE" })).status).toBe(400);
    expect(
      (await fetch(`${app.base}/api/channels/${senderKeyOf(channel)}?reason=sender_left`, { method: "DELETE" })).status,
    ).toBe(404);
    expect((await channelStatus(app, channel)).waitingReceivers).toBe(1);
    expect((await fetch(`${channel.deleteUrl}?reason=sender_left`, { method: "DELETE", keepalive: true })).status).toBe(
      204,
    );
    const refused = await waiting;
    expect(refused.status).toBe(410);
    expect(await refused.json()).toEqual(left);
    expect((await hosting.next("closed")).data).toEqual(left);
    expect(await (await fetch(`${app.base}/api/channels/${receiverKeyOf(channel)}`)).json()).toEqual(left);
  });
  test("a lease renewed beside a hosting stream ends with the stream, so a crashed tab closes one grace period later", async () => {
    const app = await server({ HOST_GRACE_MS: "300", SENDER_LEASE_MS: "5000" });
    for (const kind of ["event stream", "tracker"] as const) {
      const channel = await createChannel(app, { hostBound: true });
      const host = signal();
      const stream = sseReader(
        await fetch(kind === "tracker" ? `${app.base}/api/v1/track?format=native` : `${channel.eventsUrl}?hosting=1`, {
          signal: host.signal,
        }),
      );
      if (kind === "tracker") {
        const trackerKey = (await stream.next("tracker_event")).data.initialized.tracker_key;
        expect(
          (await fetch(`${app.base}/api/channels/${channel.id}/subscribe/${trackerKey}?hosting=1`, { method: "POST" }))
            .status,
        ).toBe(200);
      } else await stream.next("status");
      await fetch(channel.statusUrl, { headers: { "x-airshare-sender-presence": "1" } });
      await stream.cancel();
      host.abort();
      const crashedAt = Date.now();
      const closed = await until(
        () => fetch(channel.statusUrl),
        (response) => response.status === 410,
        4000,
      );
      expect(await closed.json()).toEqual(left);
      expect(Date.now() - crashedAt, kind).toBeLessThan(1500);
    }
  });
  test("an explicit presence release is pushed at once", async () => {
    const app = await server();
    const channel = await createChannel(app);
    const observer = sseReader(await fetch(channel.eventsUrl, { signal: signal().signal }));
    expect((await observer.next("status")).data.senderOnline).toBe(false);
    await fetch(channel.statusUrl, { headers: { "x-airshare-sender-presence": "1" } });
    expect((await observer.next("status")).data.senderOnline).toBe(true);
    await fetch(channel.statusUrl, { headers: { "x-airshare-sender-presence": "0" } });
    expect((await observer.next("status")).data.senderOnline).toBe(false);
  });

  test("a Station page tracker hosts its channel-perspective channels until it disconnects", async () => {
    const app = await server({ HOST_GRACE_MS: "300" });
    const pageSignal = signal();
    const page = sseReader(await fetch(`${app.base}/api/v1/track`, { signal: pageSignal.signal }));
    const trackerKey = (await page.next("tracker_event")).data.initialized.tracker_key;
    const create = async (perspective: string) =>
      (
        await fetch(`${app.base}/api/v1/channel`, {
          method: "POST",
          headers: jsonType,
          body: JSON.stringify({
            tracker: { tracker_key: trackerKey, perspective },
            file_details: { filename: `${perspective}.txt` },
          }),
        })
      ).json() as Promise<any>;
    const hosted = await create("channel");
    const watched = await create("receiver");
    const station = (details: any) => fetch(`${app.base}/api/v1/channel/receiver/${details.keys.receiver_key}`);
    await Bun.sleep(600);
    expect((await station(hosted)).status).toBe(200);
    await page.cancel();
    pageSignal.abort();
    const closed = await until(
      () => station(hosted),
      (response) => response.status === 410,
      2500,
    );
    expect(await closed.json()).toEqual(left);
    expect((await station(watched)).status).toBe(200);
  });

  test("host-bound shares survive a restart only when their tab reconnects within the grace period", async () => {
    const dir = await temporaryDataDir();
    const env = { DATA_DIR: dir.path, HOST_GRACE_MS: "1500" };
    try {
      const first = await server(env);
      const kept = await createChannel(first, { hostBound: true });
      const dropped = await createChannel(first, { hostBound: true });
      for (const channel of [kept, dropped])
        await sseReader(await fetch(`${channel.eventsUrl}?hosting=1`, { signal: signal().signal })).next("status");
      await first.close();
      servers.splice(servers.indexOf(first), 1);
      const second = await server(env);
      for (const channel of [kept, dropped]) {
        const restored = await channelStatus(second, channel);
        expect(restored.senderOnline).toBe(false);
        expect(restored.hostBound).toBe(true);
      }
      const again = sseReader(
        await fetch(`${second.base}/api/channels/${kept.id}/events?hosting=1`, { signal: signal().signal }),
      );
      expect((await again.next("status")).data.senderOnline).toBe(true);
      const closed = await until(
        () => statusOf(second.base, dropped.id),
        (response) => response.status === 410,
        4000,
      );
      expect(await closed.json()).toEqual(left);
      expect((await channelStatus(second, kept)).senderOnline).toBe(true);
      await second.close();
      servers.splice(servers.indexOf(second), 1);
    } finally {
      await dir.remove();
    }
  });

  test("status reads and plain subscriptions do not extend a used channel's life", async () => {
    const app = await server({ CHANNEL_TTL_MS: "500", CLEANUP_INTERVAL_MS: "25" });
    const channel = await createChannel(app, { contentLength: 0 });
    const download = fetch(channel.downloadUrl, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    expect(
      (await fetch(channel.uploadUrl, { method: "PUT", body: "", headers: { "x-airshare-no-redirect": "1" } })).status,
    ).toBe(200);
    await (await download).arrayBuffer();
    const watcher = sseReader(await fetch(channel.eventsUrl, { signal: signal().signal }));
    const started = Date.now();
    const expired = await until(
      () => fetch(channel.statusUrl),
      (response) => response.status === 410,
      2500,
    );
    expect(Date.now() - started).toBeLessThan(1500);
    expect(((await expired.json()) as any).reason).toBe("expired");
    expect((await watcher.next("closed")).data.reason).toBe("expired");
  });
});

describe("page status stream", () => {
  const left = { error: "The sender stopped sharing this file.", reason: "sender_left" };
  async function openStream(app: RunningServer) {
    const reader = sseReader(await fetch(`${app.base}/api/v1/track?format=native`, { signal: signal().signal }));
    const seen: string[] = [];
    const next = async (event: string, match: (data: any) => boolean = () => true): Promise<any> => {
      while (true) {
        const item = await reader.next();
        seen.push(item.event);
        if (item.event === event && match(item.data)) return item.data;
      }
    };
    const key: string = (await next("tracker_event", (data) => data.initialized)).initialized.tracker_key;
    const subscribe = (channelKey: string, hosting?: 0 | 1) =>
      fetch(
        `${app.base}/api/channels/${channelKey}/subscribe/${key}${hosting === undefined ? "" : `?hosting=${hosting}`}`,
        { method: "POST" },
      );
    const unsubscribe = (channelKey: string) =>
      fetch(`${app.base}/api/channels/${channelKey}/subscribe/${key}`, { method: "DELETE" });
    return {
      key,
      seen,
      next,
      subscribe,
      unsubscribe,
      status: (id: string, match: (data: any) => boolean = () => true) =>
        next("status", (data) => data.id === id && match(data)),
      cancel: reader.cancel,
    };
  }

  test("one native stream carries status for several channels and hosts only keys subscribed with hosting=1", async () => {
    const app = await server({ HOST_GRACE_MS: "400" });
    const page = await openStream(app);
    const hosted = await createChannel(app, { filename: "hosted.txt", hostBound: true });
    const idle = await createChannel(app, { filename: "idle.txt", hostBound: true });
    const watched = await createChannel(app, { filename: "watched.txt" });
    const first = await page.subscribe(hosted.id, 1);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      id: hosted.id,
      role: "owner",
      hostBound: true,
      senderOnline: true,
      file: { filename: "hosted.txt" },
    });
    expect(((await (await page.subscribe(idle.id)).json()) as any).senderOnline).toBe(false);
    const receiverView = await page.subscribe(receiverKeyOf(watched), 1);
    expect(await receiverView.json()).toMatchObject({
      id: receiverKeyOf(watched),
      role: "receiver",
      senderOnline: false,
    });
    expect((await page.status(hosted.id)).senderOnline).toBe(true);
    const waiting = fetch(hosted.downloadUrl, { signal: signal().signal });
    void waiting.catch(() => {});
    expect((await page.status(hosted.id, (data) => data.waitingReceivers === 1)).waitingReceivers).toBe(1);
    expect(await page.next("closed", (data) => data.id === idle.id)).toEqual({
      id: idle.id,
      key: { channel: idle.id },
      ...left,
    });
    await Bun.sleep(200);
    expect((await channelStatus(app, hosted)).senderOnline).toBe(true);
    expect((await channelStatus(app, watched)).senderOnline).toBe(false);
    expect(page.seen).not.toContain("channel_event");
    await page.cancel();
  });

  test("hosting changes and unsubscribing take effect without reconnecting the stream", async () => {
    const app = await server({ HOST_GRACE_MS: "300" });
    const page = await openStream(app);
    const channel = await createChannel(app, { hostBound: true });
    const observer = sseReader(await fetch(channel.eventsUrl, { signal: signal().signal }));
    expect((await observer.next("status")).data.senderOnline).toBe(false);
    await page.subscribe(channel.id, 1);
    expect((await observer.next("status")).data.senderOnline).toBe(true);
    await page.status(channel.id, (data) => data.senderOnline);
    await page.subscribe(channel.id, 0);
    await page.status(channel.id, (data) => !data.senderOnline);
    expect((await observer.next("status")).data.senderOnline).toBe(false);
    await Bun.sleep(150);
    await page.subscribe(channel.id, 1);
    await page.status(channel.id, (data) => data.senderOnline);
    await Bun.sleep(400);
    expect((await channelStatus(app, channel)).senderOnline).toBe(true);
    expect((await page.unsubscribe(channel.id)).status).toBe(204);
    expect((await page.unsubscribe(channel.id)).status).toBe(204);
    expect((await observer.next("closed")).data).toEqual(left);
    expect(page.seen.filter((name) => name === "closed")).toHaveLength(0);
  });

  test("closing the stream drops its hosting, and a reconnected stream keeps what it re-subscribes within the grace period", async () => {
    const app = await server({ HOST_GRACE_MS: "600" });
    const first = await openStream(app);
    const kept = await createChannel(app, { hostBound: true });
    const dropped = await createChannel(app, { hostBound: true });
    for (const channel of [kept, dropped]) expect((await first.subscribe(channel.id, 1)).status).toBe(200);
    await first.cancel();
    await until(
      () => channelStatus(app, kept),
      (value) => !value.senderOnline,
    );
    const stale = await first.subscribe(kept.id, 1);
    expect(stale.status).toBe(404);
    expect(((await stale.json()) as any).reason).toBe("tracker_not_found");
    const second = await openStream(app);
    expect(second.key).not.toBe(first.key);
    expect(((await (await second.subscribe(kept.id, 1)).json()) as any).senderOnline).toBe(true);
    const closed = await until(
      () => fetch(dropped.statusUrl),
      (response) => response.status === 410,
      2500,
    );
    expect(await closed.json()).toEqual(left);
    expect((await channelStatus(app, kept)).senderOnline).toBe(true);
    await second.cancel();
  });

  test("subscriptions report closed keys and invalid values, and respect tracker, channel and client limits", async () => {
    const app = await server({
      MAX_TRACKER_CHANNELS: "2",
      MAX_SUBSCRIBERS_PER_CHANNEL: "2",
      MAX_SUBSCRIBERS_PER_CLIENT: "3",
    });
    const page = await openStream(app);
    const [x, y, z] = [await createChannel(app), await createChannel(app), await createChannel(app)];
    expect((await page.subscribe(x.id, 1)).status).toBe(200);
    const sendPage = await page.subscribe(senderKeyOf(y), 1);
    expect(await sendPage.json()).toMatchObject({
      id: senderKeyOf(y),
      role: "sender",
      senderOnline: true,
      hostBound: false,
    });
    const full = await page.subscribe(z.id);
    expect(full.status).toBe(429);
    expect(((await full.json()) as any).reason).toBe("subscription_limit");
    expect((await page.subscribe(x.id, 0)).status).toBe(200);
    expect(
      (await fetch(`${app.base}/api/channels/${x.id}/subscribe/${page.key}?hosting=yes`, { method: "POST" })).status,
    ).toBe(400);
    expect(
      (await fetch(`${app.base}/api/channels/${"0".repeat(32)}/subscribe/${page.key}`, { method: "POST" })).status,
    ).toBe(404);
    const other = await openStream(app);
    expect((await other.subscribe(x.id)).status).toBe(200);
    const third = await openStream(app);
    expect((await third.subscribe(x.id)).status).toBe(429);
    expect((await fetch(`${app.base}/api/v1/track?format=native`, { signal: signal().signal })).status).toBe(429);
    expect((await fetch(`${app.base}/api/v1/track?format=json`, { signal: signal().signal })).status).toBe(400);
    expect((await fetch(x.deleteUrl, { method: "DELETE" })).status).toBe(204);
    expect(await page.next("closed", (data) => data.id === x.id)).toEqual({
      id: x.id,
      key: { channel: x.id },
      error: "This share was deleted.",
      reason: "deleted",
    });
    const gone = await page.subscribe(x.id, 1);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual({ error: "This share was deleted.", reason: "deleted" });
    expect((await page.subscribe(z.id)).status).toBe(200);
  });

  test("Station trackers keep Station events: owner subscriptions host, and senders_available means a waiting upload", async () => {
    const app = await server();
    const tracker = sseReader(await fetch(`${app.base}/api/v1/track`, { signal: signal().signal }));
    const trackerKey = (await tracker.next("tracker_event")).data.initialized.tracker_key;
    const channel = await createChannel(app);
    const subscribed = await fetch(`${app.base}/api/v1/channel/${channel.id}/subscribe/${trackerKey}`, {
      method: "POST",
    });
    expect(subscribed.status).toBe(200);
    const availability = async () => {
      while (true) {
        const event = await tracker.next();
        expect(event.event).not.toBe("status");
        if (event.event === "channel_event" && event.data.status) return event.data.status.senders_available;
      }
    };
    expect(await availability()).toBe(false);
    expect((await channelStatus(app, channel)).senderOnline).toBe(true);
    const uploader = signal();
    void fetch(channel.uploadUrl, {
      method: "PUT",
      body: "waiting",
      headers: { "x-airshare-no-redirect": "1" },
      signal: uploader.signal,
    }).catch(() => null);
    expect(await availability()).toBe(true);
    uploader.abort();
    expect(await availability()).toBe(false);
    expect(
      (await fetch(`${app.base}/api/v1/channel/${channel.id}/subscribe/${trackerKey}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (
        await until(
          () => channelStatus(app, channel),
          (value) => !value.senderOnline,
        )
      ).senderOnline,
    ).toBe(false);
    await tracker.cancel();
  });

  test("Station pings are empty objects every three seconds, and receiver views omit sender capabilities", async () => {
    const app = await server();
    const tracker = sseReader(await fetch(`${app.base}/api/v1/track`, { signal: signal().signal }));
    const trackerKey = (await tracker.next("tracker_event")).data.initialized.tracker_key;
    const started = Date.now();
    expect((await tracker.next("tracker_event")).data).toEqual({ ping: {} });
    expect(Date.now() - started).toBeLessThan(3600);
    const created = (await (
      await fetch(`${app.base}/api/v1/channel`, {
        method: "POST",
        headers: jsonType,
        body: JSON.stringify({ file_details: { filename: "r.txt" } }),
      })
    ).json()) as any;
    const details = (await (
      await fetch(`${app.base}/api/v1/channel/receiver/${created.keys.receiver_key}`)
    ).json()) as any;
    expect(details.urls.sender_url).toBeNull();
    expect(details.keys.sender_key).toBeUndefined();
    expect(
      (
        await fetch(`${app.base}/api/v1/channel/receiver/${created.keys.receiver_key}/subscribe/${trackerKey}`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    let status: any;
    while (!status) {
      const event = await tracker.next("channel_event");
      status = event.data.status;
    }
    expect(status).toEqual({ key: { receiver: created.keys.receiver_key }, senders_available: false });
    await tracker.cancel();
  });
});

describe("transfer reports", () => {
  const sha256 = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

  test("a no-redirect upload answers 200 with a JSON summary; Station clients and x-airshare-hash requests get the payload's SHA-256", async () => {
    const app = await server();
    const payload = "summary payload";
    for (const mode of ["native", "native-hash", "station"] as const) {
      const station = mode === "station";
      const created = station
        ? ((await (
            await fetch(`${app.base}/api/v1/channel`, {
              method: "POST",
              headers: jsonType,
              body: JSON.stringify({ file_details: { filename: "s.txt" } }),
            })
          ).json()) as any)
        : await createChannel(app, { filename: "n.txt" });
      const downloadUrl = station ? created.urls.receiver_url : created.downloadUrl;
      const uploadUrl = station ? created.urls.sender_url : created.uploadUrl;
      const statusTarget = { id: station ? created.keys.channel_key : created.id };
      const downloads = [
        fetch(downloadUrl, { signal: signal().signal }).then((r) => r.text()),
        fetch(downloadUrl, { signal: signal().signal }).then((r) => r.text()),
      ];
      await until(
        () => channelStatus(app, statusTarget),
        (value) => value.waitingReceivers === 2,
      );
      const headers: Record<string, string> = station
        ? { "com.station307.no-redirect": "true" }
        : { "x-airshare-no-redirect": "1", ...(mode === "native-hash" ? { "x-airshare-hash": "1" } : {}) };
      const upload = await fetch(uploadUrl, { method: "PUT", body: payload, headers });
      expect(upload.status).toBe(200);
      expect(upload.headers.get("content-type")).toContain("application/json");
      const counts = { bytes_sent: payload.length, bytes_received: payload.length, receiver_count: 2 };
      expect(await upload.json()).toEqual({
        succeeded: mode === "native" ? counts : { hash: sha256(payload), ...counts },
      });
      expect(await Promise.all(downloads)).toEqual([payload, payload]);
    }
  });

  test("SIGTERM still ends the server within 2 s after a hashed upload", async () => {
    for (const hashed of [false, true]) {
      const app = await startServer({}, { realShutdown: true });
      servers.push(app);
      if (hashed) {
        const channel = await createChannel(app, { filename: "h.bin" });
        const download = fetch(channel.downloadUrl, { signal: signal().signal }).then((r) => r.text());
        await until(
          () => channelStatus(app, channel),
          (value) => value.waitingReceivers === 1,
        );
        const upload = await fetch(channel.uploadUrl, {
          method: "PUT",
          body: "hashed payload",
          headers: { "x-airshare-no-redirect": "1", "x-airshare-hash": "1" },
        });
        expect(((await upload.json()) as any).succeeded.hash).toBe(sha256("hashed payload"));
        expect(await download).toBe("hashed payload");
      }
      expect(await app.terminate(), hashed ? "after a hashed upload" : "with no upload").toBeLessThan(2000);
    }
  }, 15_000);

  test("SIGTERM ends the server within 3 s while pages hold streams and receivers and uploads wait", async () => {
    const app = await startServer({}, { realShutdown: true });
    servers.push(app);
    const [hosted, tracked, waiting] = [
      await createChannel(app, { hostBound: true }),
      await createChannel(app, { hostBound: true }),
      await createChannel(app),
    ];
    const page = sseReader(await fetch(`${hosted.eventsUrl}?hosting=1`, { signal: signal().signal }));
    await page.next("status");
    const tracker = sseReader(await fetch(`${app.base}/api/v1/track?format=native`, { signal: signal().signal }));
    const trackerKey = (await tracker.next("tracker_event")).data.initialized.tracker_key;
    expect(
      (await fetch(`${app.base}/api/channels/${tracked.id}/subscribe/${trackerKey}?hosting=1`, { method: "POST" }))
        .status,
    ).toBe(200);
    const station = sseReader(await fetch(`${app.base}/api/v1/track`, { signal: signal().signal }));
    await station.next("tracker_event");
    const receiver = fetch(waiting.downloadUrl, { signal: signal().signal }).catch(() => null);
    await until(
      () => channelStatus(app, waiting),
      (value) => value.waitingReceivers === 1,
    );
    const other = await createChannel(app);
    const upload = fetch(other.uploadUrl, { method: "PUT", body: "waits", signal: signal().signal }).catch(() => null);
    await until(
      () => channelStatus(app, other),
      (value) => value.activeUpload,
    );
    // A client that never finishes its request headers.
    const url = new URL(app.base);
    const stuck = connect({ host: url.hostname, port: Number(url.port) });
    stuck.on("error", () => {});
    await new Promise<void>((resolve) => stuck.once("connect", resolve));
    stuck.write("GET /healthz HTTP/1.1\r\nHost: x\r\n");
    // And one whose JSON body never finishes.
    const halfBody = connect({ host: url.hostname, port: Number(url.port) });
    halfBody.on("error", () => {});
    await new Promise<void>((resolve) => halfBody.once("connect", resolve));
    halfBody.write(
      `POST /api/channels HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"filename":`,
    );
    await Bun.sleep(50);
    try {
      expect(await app.terminate()).toBeLessThan(3000);
      // Waiting transfers get an answer, not just a torn-down socket.
      expect((await receiver)?.status).toBe(503);
      expect((await upload)?.status).toBe(503);
    } finally {
      stuck.destroy();
      halfBody.destroy();
    }
  }, 15_000);

  test("a failed hash worker costs only its uploads' hashes; the relay keeps serving and the next hashed upload gets a fresh worker", async () => {
    const app = await server({ AIRSHARE_TEST_HASH_WORKER_FAIL: "poison" });
    const chunk = 64 * 1024;
    const upload = async (body: string | ReadableStream<Uint8Array>) => {
      const channel = await createChannel(app, { filename: "w.bin" });
      const download = fetch(channel.downloadUrl, { signal: signal().signal }).then(
        async (r) => new Uint8Array(await r.arrayBuffer()),
      );
      await until(
        () => channelStatus(app, channel),
        (value) => value.waitingReceivers === 1,
      );
      const response = await fetch(channel.uploadUrl, {
        method: "PUT",
        body,
        headers: { "x-airshare-no-redirect": "1", "x-airshare-hash": "1" },
      });
      return { status: response.status, summary: (await response.json()) as any, received: await download };
    };
    // The worker fails partway through a multi-chunk upload, after it has hashed earlier chunks.
    const poisoned = new TextEncoder().encode("poison".repeat(chunk / 6 + 1)).subarray(0, chunk);
    let sent = 0;
    const midway = await upload(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 40) return controller.close();
          controller.enqueue(sent === 32 ? poisoned : new Uint8Array(chunk).fill(sent));
          sent++;
        },
      }),
    );
    expect(midway.status).toBe(200);
    expect(midway.summary).toEqual({
      succeeded: { bytes_sent: 40 * chunk, bytes_received: 40 * chunk, receiver_count: 1 },
    });
    expect(midway.received.byteLength).toBe(40 * chunk);
    expect(app.logs()).toContain("Hash worker stopped");
    const next = await upload("clean payload");
    expect(next.summary).toEqual({
      succeeded: { hash: sha256("clean payload"), bytes_sent: 13, bytes_received: 13, receiver_count: 1 },
    });
    // A failure on the last step, while the upload waits for its digest, must not hang it either.
    const last = await upload("poison");
    expect(last.summary).toEqual({ succeeded: { bytes_sent: 6, bytes_received: 6, receiver_count: 1 } });
    expect((await upload("clean again")).summary.succeeded.hash).toBe(sha256("clean again"));
  }, 15_000);

  test("TRANSFER_HASH=off leaves the hash out everywhere", async () => {
    const app = await server({ TRANSFER_HASH: "off" });
    const created = (await (
      await fetch(`${app.base}/api/v1/channel`, {
        method: "POST",
        headers: jsonType,
        body: JSON.stringify({ file_details: { filename: "s.txt" } }),
      })
    ).json()) as any;
    const download = fetch(created.urls.receiver_url, { signal: signal().signal }).then((r) => r.text());
    await until(
      () => channelStatus(app, { id: created.keys.channel_key }),
      (value) => value.waitingReceivers === 1,
    );
    const upload = await fetch(created.urls.sender_url, {
      method: "PUT",
      body: "no hash",
      headers: { "com.station307.no-redirect": "true", "x-airshare-hash": "1" },
    });
    expect(await upload.json()).toEqual({ succeeded: { bytes_sent: 7, bytes_received: 7, receiver_count: 1 } });
    expect(await download).toBe("no hash");
  });
  test("a failed upload answers with a matching failed body", async () => {
    const app = await server();
    const channel = await createChannel(app, { contentLength: 5 });
    const downloading = fetch(channel.downloadUrl, { signal: signal().signal }).then(async (response) => {
      try {
        await response.arrayBuffer();
      } catch {}
    });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("too long body"));
        controller.close();
      },
    });
    const upload = await fetch(channel.uploadUrl, { method: "PUT", body, headers: { "x-airshare-no-redirect": "1" } });
    expect(upload.status).toBe(400);
    const result = (await upload.json()) as any;
    expect(result).toMatchObject({
      reason: "size_mismatch",
      retryable: false,
      failed: { reason: "size_mismatch", bytes_sent: 0, receiver_count: 0 },
    });
    expect(result.failed.error).toBe(result.error);
    await downloading;
  });

  test("transfer events carry timestamps, file details, received bytes, the hash and receiver departures", async () => {
    const app = await server();
    const tracking = sseReader(await fetch(`${app.base}/api/v1/track`, { signal: signal().signal }));
    const trackerKey = (await tracking.next("tracker_event")).data.initialized.tracker_key;
    const created = (await (
      await fetch(`${app.base}/api/v1/channel`, {
        method: "POST",
        headers: jsonType,
        body: JSON.stringify({
          file_details: { filename: "events.bin", content_type: "application/x-test", content_length: 262_144 },
        }),
      })
    ).json()) as any;
    const receiverUrl = (tag: string) => `${created.urls.receiver_url}?tracker=${trackerKey}&tag=${tag}`;
    const leaving = signal();
    const staying = fetch(receiverUrl("stays"), { signal: signal().signal });
    const departing = fetch(receiverUrl("leaves"), { signal: leaving.signal });
    await until(
      () => channelStatus(app, { id: created.keys.channel_key }),
      (value) => value.waitingReceivers === 2,
    );
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const bytes = new Uint8Array(262_144).map((_, index) => index % 251);
    const upload = fetch(created.urls.sender_url, {
      method: "PUT",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          input = controller;
          controller.enqueue(bytes.subarray(0, 65_536));
        },
      }),
      headers: {
        "content-length": "262144",
        "com.station307.no-redirect": "true",
        "com.station307.tracker": trackerKey,
        "com.station307.tag": "sender",
      },
      signal: signal().signal,
    });
    const events: any[] = [];
    const next = async (match: (event: any) => boolean) => {
      while (true) {
        const event = (await tracking.next("transfer_event")).data;
        events.push(event);
        if (match(event)) return event;
      }
    };
    const started = await next((event) => event.started?.tag === "sender");
    expect(started.started).toMatchObject({
      receiver_count: 2,
      filename: "events.bin",
      content_type: "application/x-test",
      file_size: 262_144,
    });
    expect(Date.parse(started.started.occurred_at)).toBeGreaterThan(0);
    const departingReader = (await departing).body!.getReader();
    await departingReader.read();
    leaving.abort();
    const left = await next((event) => event.receiver_left);
    expect(left.receiver_left).toMatchObject({ tag: "sender", reason: "receiver_disconnected", receiver_count: 1 });
    input.enqueue(bytes.subarray(65_536));
    input.close();
    expect(new Uint8Array(await (await staying).arrayBuffer())).toEqual(bytes);
    const finished = await next((event) => event.succeeded?.tag === "sender");
    expect(finished.succeeded).toMatchObject({
      hash: sha256(bytes),
      bytes_sent: 262_144,
      bytes_received: 262_144,
      receiver_count: 1,
    });
    expect(await (await upload).json()).toEqual({
      succeeded: { hash: sha256(bytes), bytes_sent: 262_144, bytes_received: 262_144, receiver_count: 1 },
    });
    const receiverDone =
      events.find((event) => event.succeeded?.tag === "stays") ??
      (await next((event) => event.succeeded?.tag === "stays"));
    expect(receiverDone.succeeded).toMatchObject({ hash: sha256(bytes), bytes_received: 262_144 });
    const progressed = events.find((event) => event.progressed?.tag === "sender");
    if (progressed) expect(progressed.progressed).toHaveProperty("bytes_received");
    expect(events.find((event) => event.started?.tag === "stays")?.started).toMatchObject({
      filename: "events.bin",
      file_size: 262_144,
    });
    await tracking.cancel();
  });
});

describe("short links", () => {
  const base58Key = /^[1-9A-HJ-NP-Za-km-z]{22}$/;

  test("new keys are 22-character base58 and payloads advertise /u and /l links", async () => {
    const app = await server({ CHANNEL_CREATION_BURST: "0" });
    const channel = await createChannel(app, { filename: "short.txt" });
    expect(channel.id).toMatch(base58Key);
    expect(senderKeyOf(channel)).toMatch(base58Key);
    expect(receiverKeyOf(channel)).toMatch(base58Key);
    expect(new Set([channel.id, senderKeyOf(channel), receiverKeyOf(channel)]).size).toBe(3);
    expect(channel.uploadUrl).toBe(`${app.base}/u/${senderKeyOf(channel)}/short.txt`);
    expect(channel.downloadUrl).toBe(`${app.base}/l/${receiverKeyOf(channel)}/short.txt`);
    expect(channel.humanUrl).toBe(`${app.base}/r/${receiverKeyOf(channel)}`);
    const station = (await (
      await fetch(`${app.base}/api/v1/channel`, {
        method: "POST",
        headers: jsonType,
        body: JSON.stringify({ file_details: { filename: "s.txt" } }),
      })
    ).json()) as any;
    expect(station.urls).toEqual({
      sender_url: `${app.base}/u/${station.keys.sender_key}/s.txt`,
      receiver_url: `${app.base}/l/${station.keys.receiver_key}/s.txt`,
    });
    const prepared = await fetch(`${app.base}/xfr/pipe.bin?prepare=1`, { method: "POST" });
    expect((await prepared.text()).trim()).toMatch(new RegExp(`^${app.base}/u/[1-9A-HJ-NP-Za-km-z]{22}/pipe\\.bin$`));
    const keys = new Set(await Promise.all(Array.from({ length: 200 }, async () => (await createChannel(app)).id)));
    expect(keys.size).toBe(200);
  });

  test("short links transfer with or without a name, enforce roles and methods, and report closed keys", async () => {
    const app = await server();
    const channel = await createChannel(app, { filename: "named.txt" });
    const shortReceive = `${app.base}/l/${receiverKeyOf(channel)}`;
    const shortSend = `${app.base}/u/${senderKeyOf(channel)}`;
    expect((await fetch(shortSend)).status).toBe(405);
    expect((await fetch(shortSend)).headers.get("allow")).toBe("POST, PUT");
    expect((await fetch(shortReceive, { method: "PUT", body: "x" })).status).toBe(405);
    expect((await fetch(`${app.base}/u/${receiverKeyOf(channel)}/x`, { method: "PUT", body: "x" })).status).toBe(404);
    expect((await fetch(`${app.base}/l/${senderKeyOf(channel)}`)).status).toBe(404);
    const unnamed = fetch(shortReceive, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    expect(
      (await fetch(shortSend, { method: "PUT", body: "first", headers: { "x-airshare-no-redirect": "1" } })).status,
    ).toBe(200);
    const first = await unnamed;
    expect(first.headers.get("content-disposition")).toContain("named.txt");
    expect(await first.text()).toBe("first");
    const renamed = fetch(`${shortReceive}/ignored-name`, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    expect(
      (
        await fetch(`${shortSend}/curl-appended.txt`, {
          method: "POST",
          body: "second",
          headers: { "x-airshare-no-redirect": "1" },
        })
      ).status,
    ).toBe(200);
    const second = await renamed;
    expect(second.headers.get("content-disposition")).toContain("curl-appended.txt");
    expect(await second.text()).toBe("second");
    expect((await fetch(channel.deleteUrl, { method: "DELETE" })).status).toBe(204);
    for (const url of [shortReceive, `${shortSend}/x`]) {
      const response = await fetch(url, {
        method: url === shortReceive ? "GET" : "PUT",
        body: url === shortReceive ? undefined : "x",
      });
      expect(response.status).toBe(410);
      expect(((await response.json()) as any).reason).toBe("deleted");
    }
  });

  test("the long routes stay aliases, and a regular-file CLI replay is redirected to the short sender link", async () => {
    const app = await server();
    const channel = await createChannel(app, { filename: "alias.txt" });
    const receiving = fetch(`${app.base}/download/${receiverKeyOf(channel)}/alias.txt`, { signal: signal().signal });
    await until(
      () => channelStatus(app, channel),
      (value) => value.waitingReceivers === 1,
    );
    const upload = await fetch(`${app.base}/api/channels/${senderKeyOf(channel)}/upload/alias.txt`, {
      method: "PUT",
      body: "alias",
      redirect: "manual",
    });
    expect(upload.status).toBe(307);
    expect(upload.headers.get("location")).toBe(`${app.base}/u/${senderKeyOf(channel)}/alias.txt`);
    expect(await (await receiving).text()).toBe("alias");
  });

  test("shares saved by earlier releases with raw 32-hex keys move to hashed keys and keep working on every route", async () => {
    const dir = await temporaryDataDir();
    try {
      const legacy = { id: "a".repeat(32), senderKey: "b".repeat(32), receiverKey: "c".repeat(32) };
      // The oldest schema: later columns were added by migrations.
      const db = new Database(join(dir.path, "channels.sqlite"), { create: true });
      db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE channels (id TEXT PRIMARY KEY, sender_key TEXT NOT NULL UNIQUE, receiver_key TEXT NOT NULL UNIQUE,
        file_json TEXT NOT NULL, created_at INTEGER NOT NULL, last_touched INTEGER NOT NULL, completed_transfers INTEGER NOT NULL DEFAULT 0)`);
      db.query("INSERT INTO channels VALUES (?, ?, ?, ?, ?, ?, 0)").run(
        legacy.id,
        legacy.senderKey,
        legacy.receiverKey,
        JSON.stringify({ filename: "legacy.txt", contentType: "text/plain", contentLength: 6 }),
        Date.now(),
        Date.now(),
      );
      db.close();
      const app = await server({ DATA_DIR: dir.path });
      expect(await rawKeysIn(dir.path, Object.values(legacy))).toEqual([]);
      const status = (await fetch(`${app.base}/api/channels/${legacy.id}`).then((response) => response.json())) as any;
      expect(status.uploadUrl).toBe(`${app.base}/u/${legacy.senderKey}/legacy.txt`);
      expect(status.downloadUrl).toBe(`${app.base}/l/${legacy.receiverKey}/legacy.txt`);
      for (const [download, upload] of [
        [status.downloadUrl, status.uploadUrl],
        [
          `${app.base}/download/${legacy.receiverKey}/legacy.txt`,
          `${app.base}/api/channels/${legacy.senderKey}/upload/legacy.txt`,
        ],
      ]) {
        const receiving = fetch(download, { signal: signal().signal });
        await until(
          () => channelStatus(app, legacy),
          (value) => value.waitingReceivers === 1,
        );
        expect(
          (await fetch(upload, { method: "PUT", body: "legacy", headers: { "x-airshare-no-redirect": "1" } })).status,
        ).toBe(200);
        expect(await (await receiving).text()).toBe("legacy");
      }
      await app.close();
      servers.splice(servers.indexOf(app), 1);
    } finally {
      await dir.remove();
    }
  });

  test("a stored key that doesn't unseal to its stored hash ends its share, and the relay keeps serving", async () => {
    const dir = await temporaryDataDir();
    try {
      const first = await server({ DATA_DIR: dir.path });
      const swapped = await createChannel(first, { filename: "swapped.txt" });
      const garbled = await createChannel(first, { filename: "garbled.txt" });
      const intact = await createChannel(first, { filename: "intact.txt" });
      await first.close();
      servers.splice(servers.indexOf(first), 1);
      const db = new Database(join(dir.path, "channels.sqlite"));
      // Sealed under the right owner key, so it decrypts, but it isn't the sender key whose hash is stored.
      db.query("UPDATE shares SET sender_sealed = ? WHERE owner_hash = ?").run(
        seal("x".repeat(22), swapped.id),
        keyHash(swapped.id),
      );
      db.query("UPDATE shares SET receiver_sealed = ? WHERE owner_hash = ?").run("AAAA", keyHash(garbled.id));
      db.close();
      const second = await server({ DATA_DIR: dir.path });
      const watching = sseReader(
        await fetch(`${second.base}/api/channels/${receiverKeyOf(swapped)}/events`, { signal: signal().signal }),
      );
      expect((await watching.next("status")).data.role).toBe("receiver");
      const owner = await fetch(`${second.base}/api/channels/${swapped.id}`);
      expect(owner.status).toBe(410);
      expect(await owner.json()).toMatchObject({ reason: "expired" });
      expect((await watching.next("closed")).data).toMatchObject({ reason: "expired" });
      expect((await fetch(`${second.base}/api/channels/${senderKeyOf(garbled)}`)).status).toBe(410);
      expect((await fetch(`${second.base}/api/channels/${receiverKeyOf(garbled)}`)).status).toBe(410);
      const kept = (await fetch(`${second.base}/api/channels/${intact.id}`).then((response) => response.json())) as any;
      expect(kept.uploadUrl).toBe(intact.uploadUrl.replace(new URL(intact.uploadUrl).origin, second.base));
      expect((await fetch(`${second.base}/healthz`)).status).toBe(200);
      expect(second.logs()).toContain("does not match its stored hash");
      await watching.cancel();
      await second.close();
      servers.splice(servers.indexOf(second), 1);
    } finally {
      await dir.remove();
    }
  });

  test("raw capability keys never reach SQLite, yet after a restart each role's key still opens its links", async () => {
    const dir = await temporaryDataDir();
    try {
      const first = await server({ DATA_DIR: dir.path });
      const channel = await createChannel(first, { filename: "kept.txt", contentLength: 4 });
      const station = (await (
        await fetch(`${first.base}/api/v1/channel`, {
          method: "POST",
          headers: jsonType,
          body: JSON.stringify({ file_details: { filename: "s.txt" } }),
        })
      ).json()) as any;
      const keys = [
        channel.id,
        senderKeyOf(channel),
        receiverKeyOf(channel),
        station.keys.channel_key,
        station.keys.sender_key,
        station.keys.receiver_key,
      ];
      const downloading = fetch(channel.downloadUrl, { signal: signal().signal });
      await until(
        () => channelStatus(first, channel),
        (value) => value.waitingReceivers === 1,
      );
      expect(
        (await fetch(channel.uploadUrl, { method: "PUT", body: "kept", headers: { "x-airshare-no-redirect": "1" } }))
          .status,
      ).toBe(200);
      expect(await (await downloading).text()).toBe("kept");
      await first.close();
      servers.splice(servers.indexOf(first), 1);
      expect(await rawKeysIn(dir.path, keys)).toEqual([]);
      const second = await server({ DATA_DIR: dir.path });
      const rebase = (url: string) => url.replace(new URL(url).origin, second.base);
      // Only the receiver key first: it opens the receiver's own view and nothing more.
      const receiver = (await fetch(`${second.base}/api/channels/${receiverKeyOf(channel)}`).then((r) =>
        r.json(),
      )) as any;
      expect(receiver).toMatchObject({
        role: "receiver",
        downloadUrl: rebase(channel.downloadUrl),
        humanUrl: rebase(channel.humanUrl),
      });
      expect(receiver.uploadUrl).toBeUndefined();
      const sender = (await fetch(`${second.base}/api/channels/${senderKeyOf(channel)}`).then((r) => r.json())) as any;
      expect(sender).toMatchObject({
        role: "sender",
        uploadUrl: rebase(channel.uploadUrl),
        downloadUrl: rebase(channel.downloadUrl),
      });
      const owner = (await fetch(`${second.base}/api/channels/${channel.id}`).then((r) => r.json())) as any;
      expect(owner).toMatchObject({
        role: "owner",
        uploadUrl: rebase(channel.uploadUrl),
        downloadUrl: rebase(channel.downloadUrl),
        deleteUrl: rebase(channel.deleteUrl),
        completedTransfers: 1,
      });
      // A sender key alone recovers the receiver key sealed under it.
      const stationSender = (await fetch(`${second.base}/api/v1/channel/sender/${station.keys.sender_key}`).then((r) =>
        r.json(),
      )) as any;
      expect(stationSender.keys).toEqual({ sender_key: station.keys.sender_key });
      expect(stationSender.urls.receiver_url).toBe(rebase(station.urls.receiver_url));
      const again = fetch(rebase(channel.downloadUrl), { signal: signal().signal });
      await until(
        () => channelStatus(second, channel),
        (value) => value.waitingReceivers === 1,
      );
      expect(
        (
          await fetch(rebase(channel.uploadUrl), {
            method: "PUT",
            body: "back",
            headers: { "x-airshare-no-redirect": "1" },
          })
        ).status,
      ).toBe(200);
      expect(await (await again).text()).toBe("back");
      expect((await fetch(owner.deleteUrl, { method: "DELETE" })).status).toBe(204);
      expect((await fetch(`${second.base}/api/channels/${receiverKeyOf(channel)}`)).status).toBe(410);
      await second.close();
      servers.splice(servers.indexOf(second), 1);
      expect(await rawKeysIn(dir.path, keys)).toEqual([]);
    } finally {
      await dir.remove();
    }
  });
});

describe("review follow-ups", () => {
  test("requests that arrive during shutdown get 503 instead of closing channels only in memory", async () => {
    const dir = await temporaryDataDir();
    const env = { DATA_DIR: dir.path, AIRSHARE_TEST_DELAY_CLOSE_MS: "800" };
    try {
      const first = await startServer(env, { graceful: true });
      servers.push(first);
      const channel = await createChannel(first);
      const closing = first.close();
      await Bun.sleep(200);
      const refused = await fetch(channel.deleteUrl, { method: "DELETE", headers: { connection: "close" } });
      expect(refused.status).toBe(503);
      expect(refused.headers.get("retry-after")).toBe("5");
      expect(((await refused.json()) as any).reason).toBe("stopping");
      await closing;
      servers.splice(servers.indexOf(first), 1);
      const second = await server({ DATA_DIR: dir.path });
      expect((await fetch(`${second.base}/api/channels/${channel.id}`)).status).toBe(200);
      await second.close();
      servers.splice(servers.indexOf(second), 1);
    } finally {
      await dir.remove();
    }
  });

  test("the closed-key record holds three keys per channel of capacity and stays bounded", async () => {
    const app = await server({ MAX_CHANNELS: "2", CHANNEL_CREATION_BURST: "0" });
    const closed = [];
    for (let index = 0; index < 3; index += 1) {
      const channel = await createChannel(app);
      expect((await fetch(channel.deleteUrl, { method: "DELETE" })).status).toBe(204);
      closed.push(channel);
    }
    const [oldest, ...recent] = closed;
    for (const key of [oldest.id, senderKeyOf(oldest), receiverKeyOf(oldest)])
      expect((await fetch(`${app.base}/api/channels/${key}`)).status).toBe(404);
    for (const channel of recent)
      for (const key of [channel.id, senderKeyOf(channel), receiverKeyOf(channel)])
        expect((await fetch(`${app.base}/api/channels/${key}`)).status).toBe(410);
  });

  test("one presence request renews many leases, reports every key, and releases them", async () => {
    const app = await server({ HOST_GRACE_MS: "300", SENDER_LEASE_MS: "400" });
    const [a, b, c] = [
      await createChannel(app, { hostBound: true }),
      await createChannel(app, { hostBound: true }),
      await createChannel(app),
    ];
    const deleted = await createChannel(app);
    await fetch(deleted.deleteUrl, { method: "DELETE" });
    const unknown = "1".repeat(22);
    const keys = [a.id, senderKeyOf(b), c.id, receiverKeyOf(c), unknown, deleted.id];
    const renew = (hosting: boolean) =>
      fetch(`${app.base}/api/presence`, {
        method: "POST",
        headers: jsonType,
        body: JSON.stringify({ keys, hosting }),
      }).then(async (response) => ({ status: response.status, body: (await response.json()) as any }));
    const first = await renew(true);
    expect(first.status).toBe(200);
    expect(Object.keys(first.body.channels).sort()).toEqual([a.id, senderKeyOf(b), c.id, receiverKeyOf(c)].sort());
    expect(first.body.channels[a.id]).toMatchObject({ role: "owner", senderOnline: true });
    expect(first.body.channels[senderKeyOf(b)]).toMatchObject({ role: "sender", senderOnline: true });
    expect(first.body.channels[receiverKeyOf(c)]).toMatchObject({ role: "receiver", senderOnline: true });
    expect(first.body.closed).toEqual({ [deleted.id]: { error: "This share was deleted.", reason: "deleted" } });
    expect(first.body.unknown).toEqual([unknown]);
    for (let index = 0; index < 6; index += 1) {
      await Bun.sleep(150);
      expect((await renew(true)).status).toBe(200);
    }
    expect((await channelStatus(app, a)).senderOnline).toBe(true);
    const released = await renew(false);
    expect(released.body.channels[a.id].senderOnline).toBe(false);
    const closed = await until(
      () => fetch(a.statusUrl),
      (response) => response.status === 410,
      2000,
    );
    expect(((await closed.json()) as any).reason).toBe("sender_left");
    for (const body of [{ keys: "x" }, { keys: [a.id, 7] }, { keys: [a.id], hosting: "yes" }]) {
      expect(
        (await fetch(`${app.base}/api/presence`, { method: "POST", headers: jsonType, body: JSON.stringify(body) }))
          .status,
      ).toBe(400);
    }
  });

  test("the presence batch limit is MAX_PRESENCE_KEYS, independent of the tracker limit, and a larger batch is told the limit", async () => {
    const post = (app: RunningServer, keys: string[]) =>
      fetch(`${app.base}/api/presence`, {
        method: "POST",
        headers: jsonType,
        body: JSON.stringify({ keys, hosting: true }),
      }).then(async (response) => ({ status: response.status, body: (await response.json()) as any }));
    const small = await server({ MAX_TRACKER_CHANNELS: "100" });
    const share = await createChannel(small, { hostBound: true });
    const batch = [share.id, ...Array.from({ length: 255 }, (_, index) => String(index + 1).padStart(22, "1"))];
    const full = await post(small, batch);
    expect(full.status).toBe(200);
    expect(full.body.channels[share.id].senderOnline).toBe(true);
    expect((await post(small, [...batch, "2".repeat(22)])).body).toEqual({
      error: "At most 256 keys per presence request",
      reason: "too_many_keys",
      max: 256,
      retryable: false,
    });
    const custom = await server({ MAX_PRESENCE_KEYS: "3" });
    expect(await post(custom, ["a", "b", "c", "d"])).toEqual({
      status: 400,
      body: { error: "At most 3 keys per presence request", reason: "too_many_keys", max: 3, retryable: false },
    });
    expect((await post(custom, ["a", "b", "c"])).status).toBe(200);
  });

  test("risky presence timers produce a startup warning", async () => {
    const app = await server({ SENDER_LEASE_MS: "1000", HOST_GRACE_MS: "5000" });
    const logs = await until(
      async () => app.logs(),
      (value) => value.includes("HOST_GRACE_MS + SENDER_LEASE_MS"),
    );
    expect(logs).toContain("SENDER_LEASE_MS=1000");
  });
});
