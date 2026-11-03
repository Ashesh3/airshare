import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { serveHttp } from "../src/http-server";

const servers: Awaited<ReturnType<typeof serveHttp>>[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

async function start(fetch: (request: Request) => Response | Promise<Response>, maxRequestBodySize = 1024 * 1024) {
  const server = await serveHttp({ hostname: "127.0.0.1", port: 0, maxRequestBodySize, fetch });
  servers.push(server);
  return server.port;
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, ms = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out")), ms); })]); }
  finally { clearTimeout(timer!); }
}
async function raw(port: number, message: string): Promise<Buffer> {
  return bounded(new Promise<Buffer>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    sockets.add(socket);
    const data: Buffer[] = [];
    socket.on("error", reject);
    socket.on("data", (chunk) => data.push(Buffer.from(chunk)));
    socket.on("close", () => { sockets.delete(socket); resolve(Buffer.concat(data)); });
    socket.on("connect", () => socket.write(message));
  }));
}
function getBody(port: number, method = "GET") {
  return bounded(new Promise<{ body: Buffer; headers: Record<string, unknown> }>((resolve, reject) => {
    const client = request({ host: "127.0.0.1", port, method, agent: false }, (response) => {
      const body: Buffer[] = [];
      response.on("data", (chunk) => body.push(chunk));
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Incomplete response")));
      response.on("end", () => resolve({ body: Buffer.concat(body), headers: response.headers }));
    });
    client.on("error", reject);
    client.end();
  }));
}

test("asynchronous stream preserves Content-Length without chunked framing and binary content", async () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, index) => index % 256);
  const port = await start(() => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(bytes.subarray(0, 400));
      await Bun.sleep(5);
      controller.enqueue(bytes.subarray(400));
      controller.close();
    },
  }), { headers: { "content-length": "1000", "content-disposition": "attachment; filename=test.bin" } }));
  const result = await getBody(port);
  expect(result.headers["content-length"]).toBe("1000");
  expect(result.headers["transfer-encoding"]).toBeUndefined();
  expect(result.headers["content-disposition"]).toBe("attachment; filename=test.bin");
  expect(result.body.length).toBe(1000);
  expect(createHash("sha256").update(result.body).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
});

test("zero byte streams preserve a zero Content-Length", async () => {
  const port = await start(() => new Response(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { "content-length": "0" } }));
  const result = await getBody(port);
  expect(result.headers["content-length"]).toBe("0");
  expect(result.body.length).toBe(0);
});

test("completed request close does not abort a delayed response", async () => {
  const port = await start(async (request) => {
    expect(await request.text()).toBe("hello");
    await Bun.sleep(30);
    return new Response(String(request.signal.aborted));
  });
  const response = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "hello" });
  expect(await response.text()).toBe("false");
});

test("sender disconnect aborts the handler request", async () => {
  const aborted = deferred();
  const entered = deferred();
  const port = await start(async (request) => {
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve();
    try { await request.text(); } catch { /* expected truncated upload */ }
    return new Response("done");
  });
  const socket = connect(port, "127.0.0.1");
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("connect", () => socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\nabc"));
  await bounded(entered.promise);
  socket.destroy();
  await bounded(aborted.promise);
});

test("a sender closing with an unread eager body still cancels a waiting handler", async () => {
  const aborted = deferred();
  const accepted = deferred();
  const port = await start(async (request) => {
    accepted.resolve();
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    await aborted.promise;
    return new Response(null, { status: 499 });
  }, 4 * 1024 * 1024);
  const socket = connect(port, "127.0.0.1");
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("data", () => {});
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write("POST /waiting HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2097152\r\n\r\n");
  await new Promise<void>((resolve, reject) => socket.write(Buffer.alloc(2 * 1024 * 1024), (error) => error ? reject(error) : resolve()));
  await accepted.promise;
  socket.destroy();
  await bounded(aborted.promise);
});

test("a live waiting body receives a proxy-compatible 103 and then its complete final response", async () => {
  const release = deferred();
  const port = await start(async (request) => { await release.promise; return new Response(await request.text(), { headers: { "content-length": "5" } }); });
  const socket = connect(port, "127.0.0.1");
  sockets.add(socket);
  let wire = "";
  const completed = new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("data", (chunk) => { wire += chunk.toString(); if (wire.includes("103 Early Hints")) release.resolve(); });
    socket.on("close", resolve);
    socket.on("connect", () => socket.write("POST /waiting HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello"));
  });
  try { await bounded(completed); }
  finally { release.resolve(); }
  expect(wire).toContain("103 Early Hints");
  expect(wire).not.toContain("102 Processing");
  expect(wire).toContain("200 OK");
  expect(wire).toEndWith("hello");
});

test("receiver disconnect cancels its response producer", async () => {
  const cancelled = deferred();
  const port = await start(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(100)); },
    cancel() { cancelled.resolve(); },
  })));
  const socket = connect(port, "127.0.0.1");
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"));
  await bounded(new Promise<void>((resolve) => socket.once("data", () => resolve())));
  socket.destroy();
  await bounded(cancelled.promise);
});

test("rejects declared oversized requests before invoking the handler", async () => {
  let calls = 0;
  const port = await start(() => { calls++; return new Response("unexpected"); }, 8);
  const response = await raw(port, "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\nConnection: close\r\n\r\n");
  expect(response.toString()).toContain("413");
  expect(calls).toBe(0);
});

test("rejects oversized chunked input without exposing bytes beyond the limit", async () => {
  let bytes = 0;
  const port = await start(async (request) => {
    const reader = request.body!.getReader();
    try { while (true) { const result = await reader.read(); if (result.done) break; bytes += result.value.byteLength; } } catch { /* limit */ }
    return new Response("done");
  }, 8);
  const response = await raw(port, "POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\n1234\r\n8\r\n56789012\r\n0\r\n\r\n");
  expect(response.toString()).toContain("413");
  expect(bytes).toBeLessThanOrEqual(8);
});

test("response stream failures and short declared bodies fail the client download", async () => {
  for (const fails of [true, false]) {
    const port = await start(() => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(10));
        await Bun.sleep(15);
        if (fails) controller.error(new Error("private source details")); else controller.close();
      },
    }), { headers: { "content-length": "1000" } }));
    await expect(getBody(port)).rejects.toThrow();
  }
});

test("slow sockets bound how much a fast response producer can enqueue", async () => {
  let produced = 0;
  const cancelled = deferred();
  const port = await start(() => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { produced += 64 * 1024; controller.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { cancelled.resolve(); },
  })));
  const socket = connect(port, "127.0.0.1");
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("connect", () => { socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"); socket.pause(); });
  await Bun.sleep(150);
  expect(produced).toBeGreaterThan(0);
  expect(produced).toBeLessThan(32 * 1024 * 1024);
  socket.destroy();
  await bounded(cancelled.promise);
});

test("HEAD and status codes without bodies terminate without streaming data", async () => {
  const port = await start(() => new Response("not for HEAD", { headers: { "content-length": "12" } }));
  expect((await getBody(port, "HEAD")).body.length).toBe(0);
  for (const status of [204, 304]) {
    const bodyless = await start(() => new Response(null, { status }));
    expect((await getBody(bodyless)).body.length).toBe(0);
  }
});

test("Expect:100-continue redirects do not start stdin uploads", async () => {
  const port = await start(() => new Response(null, { status: 307, headers: { location: "/upload" } }));
  const response = await raw(port, "PUT /create HTTP/1.1\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Length: 20\r\nConnection: close\r\n\r\n");
  expect(response.toString()).toContain("307");
  expect(response.toString()).not.toContain("100 Continue");
});

test("an eager multi-megabyte sender receives an early redirect without a reset", async () => {
  const port = await start(() => new Response(null, { status: 307, headers: { location: "/upload" } }), 32 * 1024 * 1024);
  const response = await bounded(new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    sockets.add(socket);
    const chunks: Buffer[] = [];
    socket.on("error", reject);
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("close", () => { sockets.delete(socket); resolve(Buffer.concat(chunks).toString()); });
    socket.on("connect", () => {
      // Wget writes its POST file before it reads the redirect response.
      socket.pause();
      socket.write("POST /create HTTP/1.1\r\nHost: localhost\r\nContent-Length: 16777216\r\nConnection: close\r\n\r\n");
      socket.write(Buffer.alloc(16 * 1024 * 1024), (error) => { if (error) reject(error); else socket.resume(); });
    });
  }));
  expect(response).toContain("307");
  expect(response.toLowerCase()).toContain("location: /upload");
});

test("an ignored eager upload is drained before the connection serves its next request", async () => {
  const port = await start((request) => new URL(request.url).pathname === "/create"
    ? new Response(null, { status: 307, headers: { location: "/upload" } })
    : new Response("next request"), 4 * 1024 * 1024);
  const response = await bounded(new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    sockets.add(socket);
    const chunks: Buffer[] = [];
    socket.on("error", reject);
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("close", () => { sockets.delete(socket); resolve(Buffer.concat(chunks).toString()); });
    socket.on("connect", () => {
      socket.write("POST /create HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2097152\r\n\r\n");
      socket.write(Buffer.alloc(2 * 1024 * 1024));
      socket.write("GET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    });
  }));
  expect(response).toContain("307");
  expect(response).toContain("200");
  expect(response).toContain("next request");
});

test("ignored chunked bodies remain bounded after an early redirect", async () => {
  const aborted = deferred();
  const port = await start((request) => {
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return new Response(null, { status: 307, headers: { location: "/upload" } });
  }, 8);
  const socket = connect(port, "127.0.0.1");
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("connect", () => socket.write("POST /create HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n"));
  await bounded(new Promise<void>((resolve) => socket.once("data", () => resolve())));
  socket.write("9\r\n123456789\r\n");
  await bounded(aborted.promise);
});

test("ignored upload slots are limited per client and released when the request ends", async () => {
  const listener = await serveHttp({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024,
    maxDiscards: 2, maxDiscardsPerClient: 1,
    fetch: () => new Response(null, { status: 307, headers: { location: "/upload", "content-length": "0" } }),
  });
  servers.push(listener);
  const first = connect(listener.port, "127.0.0.1");
  sockets.add(first); first.on("error", () => {});
  const closed = new Promise<void>((resolve) => first.once("close", resolve));
  await new Promise<void>((resolve) => first.once("connect", resolve));
  const response = new Promise<void>((resolve) => first.once("data", () => resolve()));
  first.write("POST /create HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\nConnection: close\r\n\r\n12345");
  await bounded(response);
  const denied = await raw(listener.port, "POST /create HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\nConnection: close\r\n\r\n12345");
  expect(denied.toString()).toContain("429");
  first.write("67890"); await bounded(closed);
  expect((await raw(listener.port, "POST /create HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx")).toString()).toContain("307");
});

test("origin-form URL uses actual HTTP origin and ignores forwarded headers", async () => {
  const port = await start((request) => new Response(request.url));
  const response = await raw(port, "GET //outside.invalid/path?q=1 HTTP/1.1\r\nHost: localhost:1234\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n");
  expect(response.toString()).toContain("http://localhost:1234//outside.invalid/path?q=1");
});

test("Expect:100-continue sends Continue when the handler reads its body", async () => {
  const port = await start(async (request) => new Response(await request.text()));
  const response = await bounded(new Promise<string>((resolve, reject) => {
    const client = request({ host: "127.0.0.1", port, method: "POST", headers: { expect: "100-continue", "content-length": "5" }, agent: false }, (incoming) => {
      let text = "";
      incoming.on("data", (chunk) => { text += chunk; });
      incoming.on("error", reject);
      incoming.on("end", () => resolve(text));
    });
    client.on("error", reject);
    client.on("continue", () => client.end("hello"));
    client.flushHeaders();
  }));
  expect(response).toBe("hello");
});

test("handler exceptions return a generic error without leaking source details", async () => {
  const port = await start(() => { throw new Error("private source details"); });
  const response = await fetch(`http://127.0.0.1:${port}/`);
  expect(response.status).toBe(500);
  expect(await response.text()).toBe("Internal server error");
});

test("force stopping one listener leaves another listener running", async () => {
  const first = await start(() => new Response("first"));
  const second = await start(() => new Response("second"));
  const listening = servers.find((server) => server.port === first)!;
  await listening.stop(true);
  await listening.stop(true);
  expect((await getBody(second)).body.toString()).toBe("second");
});
