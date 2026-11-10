import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { createChannel, startServer, type RunningServer } from "./server-helper";

class Events {
  listeners = new Map<string, Array<(event: any) => unknown>>();
  addEventListener(type: string, listener: (event: any) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: any) => unknown) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }
  emit(type: string, values: Record<string, unknown> = {}) {
    return Promise.allSettled(
      (this.listeners.get(type) ?? []).map((listener) =>
        listener({ type, target: this, currentTarget: this, preventDefault() {}, ...values }),
      ),
    );
  }
}

class ClassList {
  names = new Set<string>();
  add(...names: string[]) {
    for (const name of names) this.names.add(name);
  }
  remove(...names: string[]) {
    for (const name of names) this.names.delete(name);
  }
  toggle(name: string, force?: boolean) {
    const on = force ?? !this.names.has(name);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
  contains(name: string) {
    return this.names.has(name);
  }
}

class Element extends Events {
  textContent = "";
  value = "";
  hidden = false;
  disabled = false;
  files: File[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Element[] = [];
  parent: Element | null = null;
  nodes = new Map<string, Element>();
  className = "";
  classList = new ClassList();
  content: { firstElementChild: Element } | undefined;
  href = "";
  src = "";
  open = false;
  tagName = "DIV";
  querySelector(selector: string): Element | null {
    if (selector.startsWith("[data-channel=")) {
      const key = selector.match(/"([^"]+)"/)?.[1];
      return this.children.find((child) => child.dataset.channel === key) ?? null;
    }
    if (!this.nodes.has(selector)) {
      const element = new Element();
      element.tagName = selector.startsWith("[data-action=") ? "BUTTON" : "DIV";
      this.nodes.set(selector, element);
    }
    return this.nodes.get(selector)!;
  }
  querySelectorAll() {
    return [];
  }
  append(...children: Element[]) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  appendChild(child: Element) {
    this.append(child);
    return child;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
  cloneNode() {
    return new Element();
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  focus() {}
  select() {}
  setSelectionRange() {}
  click() {
    return this.emit("click");
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    return this.emit("close");
  }
  closest(selector: string): Element | null {
    const tags = selector.split(",").map((tag) => tag.trim().toUpperCase());
    for (let element: Element | null = this; element; element = element.parent) {
      if (tags.includes(element.tagName)) return element;
    }
    return null;
  }
  contains(child: Element) {
    return this.children.includes(child);
  }
}

const settle = async () => {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
};
type Request = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  keepalive?: boolean;
  at: number;
};

type BrowserOptions = { payloadOverrides?: Record<string, unknown>; extraScripts?: string[] };

async function browser(page = "app.js", storage = new Map<string, string>(), options: BrowserOptions = {}) {
  const file = new File(["sample file contents"], "sample.txt", { type: "text/plain" });
  const payload: Record<string, any> = {
    id: "owner-capability",
    role: "owner",
    file: { filename: file.name, contentLength: file.size, contentType: file.type },
    uploadUrl: "http://airshare.test/api/channels/sender-capability/upload/sample.txt",
    downloadUrl: "http://airshare.test/download/receiver-capability/sample.txt",
    humanUrl: "http://airshare.test/r/receiver-capability",
    eventsUrl: "http://airshare.test/api/channels/owner-capability/events",
    statusUrl: "http://airshare.test/api/channels/owner-capability",
    deleteUrl: "http://airshare.test/api/channels/owner-capability",
    waitingReceivers: 0,
    activeUpload: false,
    completedTransfers: 0,
    ...options.payloadOverrides,
  };
  let serverStatus: Record<string, unknown> = { ...payload };
  let statusOverride: ((url: string) => Response | Promise<Response>) | null = null;
  let createOverride: ((body: any) => Response | Promise<Response>) | null = null;
  let presenceOverride: ((body: { keys: string[]; hosting?: boolean }) => Response | Promise<Response>) | null = null;
  let created = 0;
  const nodes = new Map<string, Element>();
  for (const id of [
    "file-selector",
    "shared-files",
    "file-template",
    "notice",
    "drop-overlay",
    "share-dialog",
    "share-url",
    "share-qr",
    "share-caption",
    "share-feedback",
    "share-close",
    "share-copy",
    "receiver-status",
    "receiver-alert",
    "receiver-file-name",
    "receiver-file-size",
    "download",
    "send-file",
    "send-form",
    "send-button",
    "send-status",
    "send-file-name",
    "send-file-size",
    "send-progress",
    "send-note",
    "stop-hosting",
    "retry-transfer",
    "transfer-progress",
  ]) {
    nodes.set(`#${id}`, new Element());
  }
  for (const id of ["file-selector", "send-file", "share-url"]) nodes.get(`#${id}`)!.tagName = "INPUT";
  for (const id of ["send-button", "share-close", "share-copy", "stop-hosting", "retry-transfer"])
    nodes.get(`#${id}`)!.tagName = "BUTTON";
  nodes.get("#send-form")!.tagName = "FORM";
  nodes.get("#share-dialog")!.tagName = "DIALOG";
  nodes.get("#share-qr")!.tagName = "IMG";
  nodes.get("#download")!.tagName = "A";
  nodes.get("#file-template")!.content = { firstElementChild: new Element() };
  const body = new Element();
  const sources: EventSourceDouble[] = [];
  const uploads: XhrDouble[] = [];
  const writes: string[] = [];
  const intervals: Array<() => unknown> = [];
  let clipboard = "";
  let silentStreams = false;
  class EventSourceDouble extends Events {
    readyState = 1;
    closed = false;
    constructor(public url: string) {
      super();
      sources.push(this);
      if (url.includes("/api/v1/track") && !silentStreams)
        queueMicrotask(() => {
          void this.emit("tracker_event", {
            data: JSON.stringify({ initialized: { tracker_key: `tracker-${sources.length}` } }),
          });
        });
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
  }
  class XhrDouble extends Events {
    upload = new Events();
    status = 0;
    responseText = "";
    body: unknown;
    url = "";
    headers: Record<string, string> = {};
    open(_method: string, url: string) {
      this.url = String(url);
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    responseHeaders: Record<string, string> = {};
    send(value: unknown) {
      this.body = value;
      uploads.push(this);
    }
    abort() {
      void this.emit("abort");
    }
    getResponseHeader(name: string) {
      return this.responseHeaders[name.toLowerCase()] ?? null;
    }
    async finish(status = 204, text = "", headers: Record<string, string> = {}) {
      this.status = status;
      this.responseText = text;
      this.responseHeaders = headers;
      await this.emit("load");
      await settle();
    }
  }
  const documentEvents = new Events();
  const document = {
    body,
    activeElement: null as Element | null,
    hidden: false,
    querySelector(selector: string) {
      if (selector === ".empty")
        return nodes.get("#shared-files")!.children.find((child) => child.className === "empty") ?? null;
      return nodes.get(selector) ?? null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag: string) {
      const element = new Element();
      element.tagName = tag.toUpperCase();
      element.focus = () => {
        document.activeElement = element;
      };
      element.select = () => {
        document.activeElement = element;
      };
      return element;
    },
    execCommand(command: string) {
      if (command !== "copy") return false;
      clipboard = document.activeElement?.value ?? "";
      return Boolean(clipboard);
    },
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
  };
  const windowEvents = new Events();
  const requests: Request[] = [];
  let nextTimer = 1;
  let now = 0;
  const timers = new Map<number, () => unknown>();
  const timerDue = new Map<number, number>();
  const context = createContext({
    document,
    navigator: { onLine: true },
    console,
    URL,
    Response,
    File,
    DOMException,
    AbortController,
    crypto,
    EventSource: EventSourceDouble,
    XMLHttpRequest: XhrDouble,
    location: { origin: "http://airshare.test", href: "http://airshare.test/" },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes.push(key);
        storage.set(key, value);
      },
      removeItem: (key: string) => storage.delete(key),
    },
    fetch: async (
      url: string,
      init: { method?: string; headers?: Record<string, string>; body?: string; keepalive?: boolean } = {},
    ) => {
      const method = init.method || "GET";
      requests.push({
        url: String(url),
        method,
        headers: init.headers || {},
        body: init.body,
        keepalive: init.keepalive,
        at: now,
      });
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "POST" && /\/api\/channels$/.test(String(url))) {
        if (createOverride) return createOverride(JSON.parse(init.body!));
        created += 1;
        if (created === 1) return Response.json(payload, { status: 201 });
        const id = `owner-capability-${created}`;
        return Response.json(
          {
            ...payload,
            id,
            statusUrl: `http://airshare.test/api/channels/${id}`,
            deleteUrl: `http://airshare.test/api/channels/${id}`,
          },
          { status: 201 },
        );
      }
      if (method === "POST" && /\/api\/presence$/.test(String(url))) {
        const request = JSON.parse(init.body!);
        if (presenceOverride) return presenceOverride(request);
        return Response.json({
          channels: Object.fromEntries(request.keys.map((key: string) => [key, { ...serverStatus, id: key }])),
          closed: {},
          unknown: [],
        });
      }
      if (statusOverride) return statusOverride(String(url));
      const key = String(url).match(/\/api\/channels\/([^/?]+)/)?.[1];
      return Response.json(key && key !== serverStatus.id ? { ...serverStatus, id: key } : serverStatus);
    },
    alert() {},
    setTimeout: (callback: () => unknown, delay: number) => {
      const id = nextTimer++;
      timers.set(id, callback);
      timerDue.set(id, now + delay);
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
      timerDue.delete(id);
    },
    setInterval: (callback: () => unknown) => {
      intervals.push(callback);
      return intervals.length;
    },
    clearInterval(id: number) {
      if (id) intervals[id - 1] = () => {};
    },
    queueMicrotask,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  });
  context.window = context;
  const helper = new URL("../public/transfer.js", import.meta.url);
  if (existsSync(helper)) runInContext(readFileSync(helper, "utf8"), context);
  runInContext(readFileSync(new URL(`../public/${page}`, import.meta.url), "utf8"), context);
  for (const script of options.extraScripts ?? [])
    runInContext(readFileSync(new URL(`../public/${script}`, import.meta.url), "utf8"), context);
  const runFirstTimer = async () => {
    await settle();
    const [id, callback] = timers.entries().next().value!;
    timers.delete(id);
    timerDue.delete(id);
    callback();
    await settle();
  };
  const app = {
    file,
    payload,
    nodes,
    uploads,
    sources,
    context,
    storage,
    writes,
    timers,
    intervals,
    windowEvents,
    documentEvents,
    requests,
    document,
    get now() {
      return now;
    },
    showView(view: string) {
      context.AirShare.router = { current: () => view };
    },
    get clipboard() {
      return clipboard;
    },
    get card() {
      return nodes.get("#shared-files")!.children.find((child) => child.dataset.channel);
    },
    get cards() {
      return nodes.get("#shared-files")!.children.filter((child) => child.className !== "empty");
    },
    get stream() {
      return sources.filter((source) => !source.closed).at(-1);
    },
    notice() {
      return nodes.get("#notice")!.querySelector(".message")!.textContent;
    },
    noticeShown() {
      return nodes.get("#notice")!.classList.contains("active");
    },
    subscriptions(method = "POST") {
      return requests.filter((request) => request.method === method && request.url.includes("/subscribe/"));
    },
    setStatusResponse(handler: ((url: string) => Response | Promise<Response>) | null) {
      statusOverride = handler;
    },
    setCreateResponse(handler: ((body: any) => Response | Promise<Response>) | null) {
      createOverride = handler;
    },
    silenceNewStreams(silent: boolean) {
      silentStreams = silent;
    },
    setPresenceResponse(
      handler: ((body: { keys: string[]; hosting?: boolean }) => Response | Promise<Response>) | null,
    ) {
      presenceOverride = handler;
    },
    presence(hosting = true) {
      return requests
        .filter((request) => request.url.endsWith("/api/presence"))
        .map((request) => JSON.parse(request.body!))
        .filter((body) => body.hosting === hosting);
    },
    leaseHeaders() {
      return requests.filter((request) => "x-airshare-sender-presence" in request.headers);
    },
    async advance(milliseconds: number) {
      const end = now + milliseconds;
      while (true) {
        const next = Array.from(timerDue)
          .filter((entry) => entry[1] <= end)
          .sort((a, b) => a[1] - b[1])[0];
        if (!next) break;
        const [id, due] = next;
        now = due;
        const callback = timers.get(id);
        timers.delete(id);
        timerDue.delete(id);
        callback?.();
        await settle();
      }
      now = end;
    },
    async share(files: File[] = [file]) {
      nodes.get("#file-selector")!.files = files;
      await nodes.get("#file-selector")!.emit("change");
      await settle();
    },
    async status(values: Record<string, unknown>) {
      serverStatus = { ...serverStatus, ...values };
      const source = app.stream;
      if (source) await source.emit("status", { data: JSON.stringify(serverStatus) });
      else await runFirstTimer();
      await settle();
    },
    async closeEvent(reason: string, id = String(serverStatus.id)) {
      await app.stream!.emit("closed", { data: JSON.stringify({ id, key: { channel: id }, error: "closed", reason }) });
      await settle();
    },
    async reconnect() {
      await app.stream!.emit("tracker_event", {
        data: JSON.stringify({ initialized: { tracker_key: `tracker-again-${sources.length}` } }),
      });
      await settle();
    },
    async mount(view: "receiver" | "send", bootstrap: Record<string, unknown> | null) {
      const key = view === "receiver" ? "receiver-capability" : "sender-capability";
      await context.AirShare.views[view].mount({ key, bootstrap });
      await settle();
    },
    async drop(files: File[], types = ["Files"]) {
      const dataTransfer = { types, files, dropEffect: "none" };
      let prevented = false;
      await documentEvents.emit("drop", {
        dataTransfer,
        preventDefault() {
          prevented = true;
        },
      });
      await settle();
      return prevented;
    },
    async drag(type: "dragenter" | "dragover" | "dragleave", types = ["Files"]) {
      let prevented = false;
      await documentEvents.emit(type, {
        dataTransfer: { types, files: [], dropEffect: "none" },
        preventDefault() {
          prevented = true;
        },
      });
      return prevented;
    },
  };
  await settle();
  if (page === "receiver.js")
    await app.mount("receiver", {
      key: "receiver-capability",
      role: "receiver",
      channel: { ...payload, role: "receiver" },
    });
  if (page === "sender.js")
    await app.mount("send", { key: "sender-capability", role: "sender", channel: { ...payload, role: "sender" } });
  return app;
}

describe("browser transfer lifecycle", () => {
  test("the visible URL is the direct-download link as text while share URL copies the receiver page", async () => {
    const app = await browser();
    await app.share();
    const link = app.card!.querySelector('[data-field="url"]')!;
    expect(link.textContent).toBe("http://airshare.test/download/receiver-capability/sample.txt");
    await app.status({ downloadUrl: "http://airshare.test/download/receiver-capability/renamed.txt" });
    expect(link.textContent).toBe("http://airshare.test/download/receiver-capability/renamed.txt");
    await app.card!.querySelector('[data-action="copy-direct"]')!.emit("click");
    expect(app.clipboard).toBe("http://airshare.test/download/receiver-capability/renamed.txt");
    await app.card!.querySelector('[data-action="copy-human"]')!.emit("click");
    expect(app.clipboard).toBe("http://airshare.test/r/receiver-capability");
  });

  test("the QR overlay uses a local image, closes on its image and restores the trigger focus", async () => {
    const app = await browser();
    await app.share();
    const trigger = app.card!.querySelector('[data-action="qr"]')!;
    let restoredFocus = false;
    trigger.focus = () => {
      restoredFocus = true;
    };
    await trigger.emit("click");
    const dialog = app.nodes.get("#share-dialog")!;
    const qr = app.nodes.get("#share-qr")!;
    expect(dialog.open).toBe(true);
    expect(qr.src).toBe("/api/qr?url=http%3A%2F%2Fairshare.test%2Fr%2Freceiver-capability");
    await dialog.emit("click", { target: app.nodes.get("#share-url") });
    expect(dialog.open).toBe(true);
    await dialog.emit("click", { target: qr });
    expect(dialog.open).toBe(false);
    expect(restoredFocus).toBe(true);
  });

  test("starts a new complete upload for a receiver queued during the preceding upload", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    expect(app.uploads).toHaveLength(1);
    await app.status({ activeUpload: true, waitingReceivers: 0 });
    await app.status({ activeUpload: true, waitingReceivers: 1 });
    await app.status({ activeUpload: false, waitingReceivers: 1, completedTransfers: 1 });
    await app.uploads[0]!.finish();
    expect(app.uploads).toHaveLength(2);
    expect(app.uploads[1]!.body).toBe(app.file);
  });

  test("a completion already reported by the stream starts the next upload without a status request", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    const attempt = app.uploads[0]!.headers["x-airshare-upload-id"];
    await app.status({
      activeUpload: false,
      waitingReceivers: 1,
      completedTransfers: 1,
      lastUploadId: attempt,
      lastUploadReason: "completed",
    });
    const before = app.requests.filter((request) => request.method === "GET").length;
    await app.uploads[0]!.finish();
    expect(app.uploads).toHaveLength(2);
    expect(app.requests.filter((request) => request.method === "GET")).toHaveLength(before);
  });

  for (const [form, uploadUrl, expected] of [
    [
      "short",
      "http://airshare.test/u/sender-capability/other.txt",
      "http://airshare.test/u/sender-capability/report%20draft.txt",
    ],
    [
      "legacy",
      "http://airshare.test/api/channels/sender-capability/upload/other.txt",
      "http://airshare.test/api/channels/sender-capability/upload/report%20draft.txt",
    ],
  ] as const) {
    test(`uploads to the ${form} upload link with the shared file's own name and no hash request`, async () => {
      const app = await browser("app.js", new Map(), { payloadOverrides: { uploadUrl } });
      await app.share([new File(["draft"], "report draft.txt")]);
      await app.status({ waitingReceivers: 1 });
      expect(app.uploads[0]!.url).toBe(expected);
      expect(app.uploads[0]!.headers["x-airshare-no-redirect"]).toBe("1");
      expect(app.uploads[0]!.headers).not.toHaveProperty("x-airshare-hash");
    });
  }

  test("a 200 upload summary counts as a completed transfer", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.status({ waitingReceivers: 0, activeUpload: false, completedTransfers: 1 });
    const seen = new Set<string>();
    await app.uploads[0]!.finish(
      200,
      JSON.stringify({ succeeded: { bytes_sent: 20, bytes_received: 20, receiver_count: 1 } }),
    );
    for (let step = 0; step < 40; step += 1) {
      seen.add(app.notice());
      await app.advance(100);
    }
    expect(seen.has("A transfer succeeded")).toBe(true);
    expect(app.card!.classList.contains("has-error")).toBe(false);
    expect(app.card!.querySelector('[data-field="transfers-label"]')!.textContent).toBe("upload");
  });

  test("a busy channel waits for the running transfer instead of failing", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    // Another sender's upload took the channel first.
    await app.status({ activeUpload: true, waitingReceivers: 0 });
    const gets = app.requests.filter((request) => request.method === "GET").length;
    const seen = new Set<string>();
    await app.uploads[0]!.finish(
      409,
      JSON.stringify({
        error: "A transfer is in progress on this channel; retry when it finishes",
        reason: "busy",
        retryable: false,
      }),
    );
    for (let step = 0; step < 60; step += 1) {
      seen.add(app.notice());
      await app.advance(100);
    }
    expect(seen.has("A transfer failed")).toBe(false);
    expect(app.card!.classList.contains("has-error")).toBe(false);
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/another sender is transferring/i);
    expect(app.requests.filter((request) => request.method === "GET").length).toBe(gets + 1);
    expect(app.uploads).toHaveLength(1);
    await app.status({ activeUpload: false, waitingReceivers: 1 });
    expect(app.uploads).toHaveLength(2);
  });

  test("an upload over the relay's per-client limit waits for Retry-After and tries again without a failure", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    const limited = JSON.stringify({
      error: "Too many uploads from this client at once",
      reason: "upload_limit",
      retryable: false,
    });
    await app.uploads[0]!.finish(429, limited, { "retry-after": "2" });
    const seen = new Set<string>();
    for (let step = 0; step < 19; step += 1) {
      seen.add(app.notice());
      seen.add(app.card!.querySelector(".status-text")!.textContent);
      await app.advance(100);
    }
    expect(app.uploads).toHaveLength(1);
    await app.advance(200);
    expect(app.uploads).toHaveLength(2);
    await app.uploads[1]!.finish(429, limited, { "retry-after": "1" });
    await app.advance(1000);
    expect(app.uploads).toHaveLength(3);
    for (let step = 0; step < 40; step += 1) {
      seen.add(app.notice());
      await app.advance(100);
    }
    expect(seen.has("A transfer failed")).toBe(false);
    expect([...seen].some((text) => /failed|limit/i.test(text))).toBe(false);
    expect(app.card!.classList.contains("has-error")).toBe(false);
    expect(app.card!.classList.contains("has-status")).toBe(false);
    await app.status({ waitingReceivers: 0, activeUpload: false, completedTransfers: 1 });
    await app.uploads[2]!.finish();
    expect(app.card!.querySelector('[data-field="transfers-label"]')!.textContent).toBe("upload");
  });

  test("keeps upload failures visible after cleanup and later status updates", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.uploads[0]!.finish(503, "Receiver disconnected");
    await app.status({ waitingReceivers: 0, activeUpload: false });
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/failed.*receiver disconnected/i);
    expect(app.card!.classList.contains("has-error")).toBe(true);
    expect(app.uploads).toHaveLength(1);
  });

  test("stopping an upload cannot resurrect its removed card through a late callback", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    const stream = app.stream!;
    await app.card!.querySelector('[data-action="delete"]')!.emit("click");
    await settle();
    expect(app.card).toBeUndefined();
    await stream.emit("status", { data: JSON.stringify({ ...app.payload, waitingReceivers: 1 }) });
    await settle();
    expect(app.card).toBeUndefined();
    expect(app.uploads).toHaveLength(1);
  });

  test("copies a share link on HTTP where the Clipboard API is unavailable", async () => {
    const app = await browser();
    await app.share();
    await app.card!.querySelector('[data-action="copy-human"]')!.emit("click");
    await settle();
    expect(app.clipboard).toBe("http://airshare.test/r/receiver-capability");
  });

  test("shows a lost status connection on the row and recovers when status returns", async () => {
    const app = await browser();
    await app.share();
    app.setStatusResponse(() => {
      throw new TypeError("Failed to fetch");
    });
    await app.stream!.emit("error");
    await settle();
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/reconnect/i);
    expect(app.card!.classList.contains("has-status")).toBe(true);
    app.setStatusResponse(null);
    await app.reconnect();
    await app.status({ waitingReceivers: 0 });
    expect(app.card!.querySelector(".status-text")!.textContent).not.toMatch(/reconnect/i);
    expect(app.card!.classList.contains("has-status")).toBe(false);
  });

  test("status polling reserves browser connections by running at most two requests at once", async () => {
    const app = await browser();
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    app.context.fetch = (_url: string, options: { signal: AbortSignal }) =>
      new Promise<Response>((resolve, reject) => {
        active += 1;
        peak = Math.max(peak, active);
        const release = () => {
          active -= 1;
          resolve(Response.json(app.payload));
        };
        releases.push(release);
        options.signal.addEventListener(
          "abort",
          () => {
            active -= 1;
            reject(options.signal.reason);
          },
          { once: true },
        );
      });
    const connections = Array.from(
      { length: 7 },
      () => new app.context.AirShare.ChannelConnection(app.payload, () => {}, { useStream: false }),
    );
    for (const connection of connections) connection.connect();
    await settle();
    expect(peak).toBe(2);
    expect(app.sources).toHaveLength(0);
    releases.shift()!();
    await settle();
    expect(peak).toBe(2);
    for (const connection of connections) connection.disconnect();
    await settle();
  });

  test("a stalled status request times out so other shares can still obtain status", async () => {
    const app = await browser();
    let started = 0;
    app.context.fetch = (_url: string, options: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        started += 1;
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    const connections = Array.from(
      { length: 4 },
      () => new app.context.AirShare.ChannelConnection(app.payload, () => {}, { useStream: false }),
    );
    for (const connection of connections) connection.connect();
    await settle();
    expect(started).toBe(2);
    await app.advance(12000);
    expect(started).toBeGreaterThanOrEqual(4);
    expect(connections[0].reconnecting).toBe(true);
    for (const connection of connections) connection.disconnect();
    await settle();
  });

  test("100% browser upload progress does not claim that receivers have finished, and the bar resets afterwards", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.uploads[0]!.upload.emit("progress", {
      lengthComputable: true,
      loaded: app.file.size / 2,
      total: app.file.size,
    });
    expect(app.card!.querySelector(".upload-progress span")!.style.width).toBe("50%");
    await app.uploads[0]!.upload.emit("progress", {
      lengthComputable: true,
      loaded: app.file.size,
      total: app.file.size,
    });
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/waiting.*finish/i);
    expect(app.card!.querySelector(".status-text")!.textContent).not.toMatch(/transfer complete/i);
    await app.status({ activeUpload: false, waitingReceivers: 0, completedTransfers: 1 });
    await app.uploads[0]!.finish();
    expect(app.card!.querySelector(".upload-progress span")!.style.width).toBe("0%");
    expect(app.card!.querySelector('[data-field="transfers"]')!.textContent).toBe("1");
    expect(app.card!.querySelector('[data-field="transfers-label"]')!.textContent).toBe("upload");
    await app.status({ completedTransfers: 2 });
    expect(app.card!.querySelector('[data-field="transfers-label"]')!.textContent).toBe("uploads");
  });

  test("an explicit retry resumes a failed upload without an automatic retry loop", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.uploads[0]!.finish(503, "Receiver disconnected");
    await app.status({ waitingReceivers: 1 });
    expect(app.uploads).toHaveLength(1);
    await app.card!.querySelector('[data-action="retry"]')!.emit("click");
    await settle();
    expect(app.uploads).toHaveLength(2);
  });

  for (const reason of ["no_receivers", "receiver_stalled"]) {
    test(`a ${reason} outcome keeps hosting and serves a later receiver without manual retry`, async () => {
      const app = await browser();
      await app.share();
      await app.status({ waitingReceivers: 1 });
      await app.status({ waitingReceivers: 0, activeUpload: false });
      await app.uploads[0]!.finish(409, JSON.stringify({ error: "The receiver left", reason, retryable: true }));
      expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/still hosting/i);
      expect(app.card!.classList.contains("has-status")).toBe(true);
      expect(app.card!.querySelector('[data-action="retry"]')!.hidden).toBe(true);
      expect(app.subscriptions("DELETE")).toHaveLength(0);
      expect(app.subscriptions().at(-1)!.url).toContain("hosting=1");
      await app.status({ waitingReceivers: 1 });
      await app.advance(100);
      expect(app.uploads).toHaveLength(1);
      await app.advance(6000);
      expect(app.uploads).toHaveLength(2);
      expect(app.uploads[1]!.body).toBe(app.file);
      await app.status({ waitingReceivers: 0, activeUpload: false, completedTransfers: 1 });
      await app.uploads[1]!.finish();
      expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/transfer complete/i);
    });
  }

  test("repeated recoverable receiver departures back off without blocking future receivers indefinitely", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await app.uploads[attempt]!.finish(
        409,
        JSON.stringify({ error: "Receiver timed out", reason: "receiver_stalled", retryable: true }),
      );
      expect(app.uploads).toHaveLength(attempt + 1);
      await app.advance(100);
      expect(app.uploads).toHaveLength(attempt + 1);
      await app.advance(6000);
      expect(app.uploads).toHaveLength(attempt + 2);
    }
  });

  test("an XHR transport failure recovers only after a matching retryable terminal upload outcome", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    const uploadId = app.uploads[0]!.headers["x-airshare-upload-id"];
    expect(uploadId).toBeString();
    expect(uploadId!.length).toBeGreaterThan(0);
    await app.status({ waitingReceivers: 0, activeUpload: true, activeUploadId: uploadId });
    await app.uploads[0]!.emit("error");
    await settle();
    await app.advance(6000);
    expect(app.uploads).toHaveLength(1);
    await app.status({
      waitingReceivers: 1,
      activeUpload: false,
      lastUploadId: "another-attempt",
      lastUploadReason: "no_receivers",
      lastUploadRetryable: true,
    });
    await app.advance(6000);
    expect(app.uploads).toHaveLength(1);
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/transfer failed/i);
    await app.status({
      waitingReceivers: 1,
      activeUpload: false,
      lastUploadId: uploadId,
      lastUploadReason: "no_receivers",
      lastUploadRetryable: true,
    });
    await app.advance(6000);
    expect(app.uploads).toHaveLength(2);
    expect(app.uploads[1]!.headers["x-airshare-upload-id"]).not.toBe(uploadId);
    expect(app.uploads[1]!.body).toBe(app.file);
  });

  test("an upload cut by a relay restart is retried automatically once the relay is back and a receiver waits", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    app.setStatusResponse(offline);
    app.setPresenceResponse(offline);
    app.stream!.readyState = 0;
    await app.stream!.emit("error");
    await app.uploads[0]!.emit("error");
    await app.advance(0);
    await settle();
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/^Transfer failed/);
    app.setPresenceResponse(null);
    app.setStatusResponse((url) =>
      Response.json({
        ...app.payload,
        id: url.includes("/subscribe/") ? app.payload.id : app.payload.id,
        waitingReceivers: 0,
      }),
    );
    await app.reconnect();
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/^Transfer failed/);
    app.setStatusResponse(null);
    await app.status({ waitingReceivers: 1, activeUpload: false });
    expect(app.card!.querySelector(".status-text")!.textContent).toBe(
      "The connection to the relay was interrupted. Still hosting for the next receiver.",
    );
    expect(app.card!.classList.contains("has-error")).toBe(false);
    await app.advance(500);
    expect(app.uploads).toHaveLength(2);
    expect(app.uploads[1]!.body).toBe(app.file);
  });

  test("an upload the relay answers with 503 stopping as it restarts is sent again once the relay is back, unlike other 503s", async () => {
    for (const reason of ["stopping", "upload_failed"]) {
      const app = await browser();
      await app.share();
      await app.status({ waitingReceivers: 1 });
      const offline = () => Promise.reject(new TypeError("Failed to fetch"));
      app.setStatusResponse(offline);
      app.setPresenceResponse(offline);
      // The answer can arrive before the status stream notices the relay going away.
      const error = reason === "stopping" ? "The server is restarting; retry shortly" : "Relay error";
      const answer = { error, reason, retryable: false };
      await app.uploads[0]!.finish(503, JSON.stringify(answer), { "retry-after": "5" });
      app.stream!.readyState = 0;
      await app.stream!.emit("error");
      await app.advance(0);
      expect(app.card!.querySelector(".status-text")!.textContent, reason).toMatch(/^Transfer failed/);
      app.setStatusResponse(null);
      app.setPresenceResponse(null);
      await app.reconnect();
      await app.status({ waitingReceivers: 1, activeUpload: false });
      await app.advance(500);
      expect(app.uploads, reason).toHaveLength(reason === "stopping" ? 2 : 1);
      expect(app.card!.classList.contains("has-error"), reason).toBe(reason !== "stopping");
    }
  });

  test("an interrupted upload is not retried while the relay never dropped the page's status connection", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.uploads[0]!.emit("error");
    await app.advance(0);
    await app.status({ waitingReceivers: 1, activeUpload: false });
    await app.advance(10000);
    expect(app.uploads).toHaveLength(1);
    expect(app.card!.classList.contains("has-error")).toBe(true);
  });

  test("automatic retries after interrupted uploads stop after three and leave Retry", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      app.setStatusResponse(offline);
      app.setPresenceResponse(offline);
      await app.uploads.at(-1)!.emit("error");
      await app.advance(0);
      await settle();
      app.setStatusResponse(null);
      app.setPresenceResponse(null);
      await app.reconnect();
      await app.advance(10000);
    }
    expect(app.uploads).toHaveLength(4);
    expect(app.card!.classList.contains("has-error")).toBe(true);
    expect(app.card!.querySelector('[data-action="retry"]')!.hidden).toBe(false);
    await app.card!.querySelector('[data-action="retry"]')!.emit("click");
    await settle();
    expect(app.uploads).toHaveLength(5);
  });

  test("size and validation failures stay explicit even when later status mentions a recoverable receiver error", async () => {
    for (const reason of ["size_mismatch", "invalid_metadata"]) {
      const app = await browser();
      await app.share();
      await app.status({ waitingReceivers: 1 });
      const uploadId = app.uploads[0]!.headers["x-airshare-upload-id"];
      await app.uploads[0]!.finish(400, JSON.stringify({ error: "Invalid file data", reason, retryable: false }));
      await app.status({
        waitingReceivers: 1,
        activeUpload: false,
        lastUploadId: uploadId,
        lastUploadReason: "no_receivers",
        lastUploadRetryable: true,
      });
      await app.advance(12000);
      expect(app.uploads).toHaveLength(1);
      expect(app.card!.querySelector(".status-text")!.textContent).toContain("Invalid file data");
      expect(app.card!.querySelector('[data-action="retry"]')!.hidden).toBe(false);
    }
  });

  test("stopping a share cancels pending automatic recovery, unsubscribes and closes the idle stream", async () => {
    const app = await browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.uploads[0]!.finish(
      409,
      JSON.stringify({ error: "Receiver left", reason: "no_receivers", retryable: true }),
    );
    await app.card!.querySelector('[data-action="delete"]')!.emit("click");
    await app.advance(20000);
    expect(app.card).toBeUndefined();
    expect(app.uploads).toHaveLength(1);
    expect(app.subscriptions("DELETE").map((request) => new URL(request.url).pathname)).toEqual([
      "/api/channels/owner-capability/subscribe/tracker-1",
    ]);
    expect(app.sources.every((source) => source.closed)).toBe(true);
  });
});

describe("toasts", () => {
  test("toasts use Station307 wording, show one at a time in order and fade after about 1.5 s", async () => {
    const app = await browser();
    await app.share([app.file, new File(["second"], "second.txt")]);
    expect(app.notice()).toBe("Added sample.txt");
    expect(app.noticeShown()).toBe(true);
    await app.advance(1500);
    expect(app.noticeShown()).toBe(false);
    expect(app.notice()).toBe("Added sample.txt");
    await app.advance(300);
    expect(app.notice()).toBe("Added second.txt");
    expect(app.noticeShown()).toBe(true);
    await app.advance(1800);
    expect(app.notice()).toBe("");
    await app.card!.querySelector('[data-action="copy-human"]')!.emit("click");
    expect(app.notice()).toBe("Sharing link copied");
    await app.advance(1800);
    await app.card!.querySelector('[data-action="copy-direct"]')!.emit("click");
    expect(app.notice()).toBe("Direct download link copied");
  });

  test("the toast queue keeps the newest five, collapses repeats and lets copies go first", async () => {
    const app = await browser();
    const { toast } = app.context.AirShare;
    toast("one");
    toast("one");
    toast("two");
    toast("two");
    for (const message of ["three", "four", "five", "six", "seven"]) toast(message);
    toast("Sharing link copied", { priority: true });
    const shown: string[] = [];
    for (let step = 0; step < 150; step += 1) {
      const message = app.notice();
      if (message && shown.at(-1) !== message) shown.push(message);
      await app.advance(100);
    }
    expect(shown).toEqual(["one", "Sharing link copied", "four", "five", "six", "seven"]);
  });

  test("a repeat that arrives while the same toast fades out is shown again, but not one that arrives while it is visible", async () => {
    const app = await browser();
    const { toast } = app.context.AirShare;
    toast("Upload completed");
    await app.advance(1000);
    toast("Upload completed");
    await app.advance(500);
    expect(app.noticeShown()).toBe(false);
    toast("Upload completed");
    await app.advance(300);
    expect(app.noticeShown()).toBe(true);
    expect(app.notice()).toBe("Upload completed");
    await app.advance(1800);
    expect(app.noticeShown()).toBe(false);
    expect(app.notice()).toBe("");
  });

  test("transfers announce their start, success and failure, and delete stays silent", async () => {
    const app = await browser();
    await app.share();
    await app.advance(2000);
    await app.status({ waitingReceivers: 1 });
    expect(app.notice()).toBe("Starting upload of sample.txt");
    await app.status({ waitingReceivers: 0, activeUpload: false, completedTransfers: 1 });
    await app.uploads[0]!.finish();
    await app.advance(1800);
    expect(app.notice()).toBe("A transfer succeeded");
    await app.advance(1800);
    await app.status({ waitingReceivers: 1 });
    await app.advance(1800);
    await app.uploads[1]!.finish(503, "Receiver disconnected");
    expect(app.notice()).toBe("A transfer failed");
    await app.advance(1800);
    await app.card!.querySelector('[data-action="delete"]')!.emit("click");
    await settle();
    expect(app.notice()).toBe("");
  });

  test("copy failures and channel creation failures are error toasts that stay longer", async () => {
    const app = await browser();
    app.setCreateResponse((body) =>
      body.filename === "sample.txt"
        ? Response.json({ error: "Channel limit reached" }, { status: 503 })
        : Response.json(app.payload, { status: 201 }),
    );
    await app.share([app.file, new File(["second"], "second.txt")]);
    await app.advance(3600);
    expect(app.notice()).toBe("Could not add sample.txt: Channel limit reached");
    expect(app.nodes.get("#notice")!.classList.contains("is-error")).toBe(true);
    await app.advance(3000);
    expect(app.noticeShown()).toBe(true);
    await app.advance(1500);
    expect(app.noticeShown()).toBe(false);
    expect(app.cards).toHaveLength(1);
    app.context.document.execCommand = () => false;
    await app.advance(500);
    await app.card!.querySelector('[data-action="copy-human"]')!.emit("click");
    expect(app.notice()).toBe("Could not copy the link");
  });
});

describe("share rows", () => {
  test("a new row appears at once as preparing transfer with only delete until its channel exists", async () => {
    const app = await browser();
    let resolve!: (response: Response) => void;
    app.setCreateResponse(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    await app.share();
    const row = app.cards[0]!;
    expect(row.querySelector(".name")!.textContent).toBe("sample.txt");
    expect(row.querySelector('[data-field="url"]')!.textContent).toBe("preparing transfer...");
    for (const action of ["qr", "copy-human", "copy-direct"])
      expect(row.querySelector(`[data-action="${action}"]`)!.hidden).toBe(true);
    expect(row.querySelector('[data-action="delete"]')!.hidden).toBe(false);
    resolve(Response.json(app.payload, { status: 201 }));
    await settle();
    expect(row.querySelector('[data-field="url"]')!.textContent).toBe(app.payload.downloadUrl);
    for (const action of ["qr", "copy-human", "copy-direct"])
      expect(row.querySelector(`[data-action="${action}"]`)!.hidden).toBe(false);
  });

  test("deleting a preparing row removes it and deletes the channel once it is created", async () => {
    const app = await browser();
    let resolve!: (response: Response) => void;
    app.setCreateResponse(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    await app.share();
    await app.cards[0]!.querySelector('[data-action="delete"]')!.emit("click");
    expect(app.cards).toHaveLength(0);
    expect(app.nodes.get("#shared-files")!.children.some((child) => child.className === "empty")).toBe(true);
    resolve(Response.json(app.payload, { status: 201 }));
    await settle();
    expect(app.cards).toHaveLength(0);
    expect(app.requests.filter((request) => request.method === "DELETE").map((request) => request.url)).toEqual([
      "http://airshare.test/api/channels/owner-capability",
    ]);
    expect(app.sources).toHaveLength(0);
  });

  test("the empty state uses the same element after the last share is deleted", async () => {
    const app = await browser();
    await app.share();
    await app.card!.querySelector('[data-action="delete"]')!.emit("click");
    await settle();
    const empty = app.nodes.get("#shared-files")!.children.find((child) => child.className === "empty")!;
    expect(empty.tagName).toBe("DIV");
    expect(empty.children[0]!.tagName).toBe("P");
    expect(empty.children[0]!.textContent).toBe("No files have been added yet");
  });
});

// Records every state change of every host session created in this page.
function recordTransitions(app: { context: any }) {
  const log: string[] = [];
  const proto = app.context.AirShare.HostSession.prototype;
  const to = proto.to;
  proto.to = function (this: { state: string }, next: string) {
    const from = this.state;
    to.call(this, next);
    if (from !== next) log.push(`${from}>${next}`);
  };
  return log;
}

describe("host session states", () => {
  const states = ["idle", "waiting", "uploading", "reconciling", "recovering", "failed", "paused", "closed"];

  test("the transition table covers every state, every live state can stop or close, and closed is final", async () => {
    const app = await browser();
    const table = app.context.AirShare.HostSession.TRANSITIONS;
    expect(Object.keys(table).sort()).toEqual([...states].sort());
    expect(Object.isFrozen(table)).toBe(true);
    for (const [from, targets] of Object.entries(table) as Array<[string, string[]]>) {
      for (const target of targets) expect(states).toContain(target);
      expect(targets).not.toContain(from);
      if (from !== "closed") expect(targets).toContain("closed");
      if (from !== "closed" && from !== "paused") expect(targets).toContain("paused");
    }
    expect(table.closed).toEqual([]);
    expect(table.paused).toEqual(["waiting", "closed"]);
  });

  test("a disallowed transition throws and leaves the state unchanged", async () => {
    const app = await browser();
    const session = new app.context.AirShare.HostSession({ ...app.payload }, () => {});
    expect(session.state).toBe("idle");
    expect(() => session.to("uploading")).toThrow("A host cannot go from idle to uploading");
    expect(session.state).toBe("idle");
    session.dispose();
    expect(session.state).toBe("closed");
    expect(() => session.to("waiting")).toThrow("A host cannot go from closed to waiting");
    expect(session.setFile(app.file)).toBe(false);
    expect(session.state).toBe("closed");
  });

  test("a finished upload reconciles before serving the receiver who joined during it", async () => {
    const app = await browser();
    const log = recordTransitions(app);
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.status({ activeUpload: true, waitingReceivers: 1 });
    await app.status({ activeUpload: false, waitingReceivers: 1, completedTransfers: 1 });
    await app.uploads[0]!.finish();
    expect(log).toEqual([
      "idle>waiting",
      "waiting>uploading",
      "uploading>waiting",
      "waiting>reconciling",
      "reconciling>waiting",
      "waiting>uploading",
    ]);
  });

  test("a completion the stream already reported skips reconciling", async () => {
    const app = await browser();
    const log = recordTransitions(app);
    await app.share();
    await app.status({ waitingReceivers: 1 });
    const attempt = app.uploads[0]!.headers["x-airshare-upload-id"];
    await app.status({
      activeUpload: false,
      waitingReceivers: 0,
      completedTransfers: 1,
      lastUploadId: attempt,
      lastUploadReason: "completed",
    });
    await app.uploads[0]!.finish();
    expect(log).toEqual(["idle>waiting", "waiting>uploading", "uploading>waiting"]);
  });

  test("a receiver who leaves is recovered without an error", async () => {
    const app = await browser();
    const log = recordTransitions(app);
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.status({ activeUpload: false, waitingReceivers: 0 });
    await app.uploads[0]!.finish(
      409,
      JSON.stringify({ error: "The receiver disconnected", reason: "no_receivers", retryable: true }),
    );
    expect(log.at(-1)).toBe("waiting>recovering");
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/still hosting/i);
    await app.advance(500);
    expect(log).toEqual([
      "idle>waiting",
      "waiting>uploading",
      "uploading>waiting",
      "waiting>recovering",
      "recovering>reconciling",
      "reconciling>waiting",
    ]);
    expect(app.card!.classList.contains("has-error")).toBe(false);
  });

  test("a failed upload stays failed until Retry", async () => {
    const app = await browser();
    const log = recordTransitions(app);
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.uploads[0]!.finish(500, "Relay error");
    await app.status({ waitingReceivers: 1 });
    expect(app.uploads).toHaveLength(1);
    expect(log.at(-1)).toBe("uploading>failed");
    await app.card!.querySelector('[data-action="retry"]')!.emit("click");
    await settle();
    expect(log).toEqual([
      "idle>waiting",
      "waiting>uploading",
      "uploading>failed",
      "failed>reconciling",
      "reconciling>waiting",
      "waiting>uploading",
    ]);
    expect(app.uploads).toHaveLength(2);
  });

  test("an upload over the relay's per-client limit waits quietly in recovering, and one cut by a restart recovers from failed", async () => {
    const app = await browser();
    const log = recordTransitions(app);
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.uploads[0]!.finish(429, JSON.stringify({ reason: "upload_limit" }), { "retry-after": "1" });
    await app.advance(1000);
    expect(log).toEqual([
      "idle>waiting",
      "waiting>uploading",
      "uploading>waiting",
      "waiting>recovering",
      "recovering>reconciling",
      "reconciling>waiting",
      "waiting>uploading",
    ]);
    log.length = 0;
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    app.setStatusResponse(offline);
    app.setPresenceResponse(offline);
    await app.uploads[1]!.emit("error");
    await app.advance(0);
    await settle();
    app.setStatusResponse(null);
    app.setPresenceResponse(null);
    await app.reconnect();
    await app.advance(500);
    expect(log).toEqual([
      "uploading>failed",
      "failed>recovering",
      "recovering>reconciling",
      "reconciling>waiting",
      "waiting>uploading",
    ]);
  });

  test("an attempt superseded while it refreshes after a transport failure leaves the newer attempt alone", async () => {
    const app = await browser();
    const sessions: any[] = [];
    const proto = app.context.AirShare.HostSession.prototype;
    const setFile = proto.setFile;
    proto.setFile = function (this: unknown, file: File) {
      sessions.push(this);
      return setFile.call(this, file);
    };
    const log = recordTransitions(app);
    await app.share();
    await app.status({ waitingReceivers: 1 });
    expect(app.uploads).toHaveLength(1);
    const session = sessions[0];
    let releaseStale: (() => void) | undefined;
    app.setStatusResponse(
      () =>
        new Promise<Response>((resolve) => {
          releaseStale = () => resolve(Response.json({ ...app.payload, waitingReceivers: 1 }));
        }),
    );
    await app.uploads[0]!.emit("error");
    await settle();
    expect(releaseStale, "the failed attempt waits for its status refresh").toBeDefined();
    app.setStatusResponse(null);
    session.pause();
    session.setFile(app.file);
    await session.retry();
    await settle();
    expect(app.uploads).toHaveLength(2);
    expect(session.state).toBe("uploading");
    const newer = session.controller;
    expect(newer).not.toBeNull();
    const seen = log.length;
    releaseStale!();
    await settle();
    expect(log.slice(seen), "the stale attempt changes no state").toEqual([]);
    expect(session.controller).toBe(newer);
    await app.uploads[1]!.upload.emit("progress", { lengthComputable: true, loaded: 5, total: 10 });
    expect(session.progress).toBe(50);
    await app.uploads[1]!.finish();
    expect(log.slice(seen)[0]).toBe("uploading>waiting");
    expect(session.error).toBe("");
  });

  test("a closed share ends in closed, and deleting a row stops it before closing it", async () => {
    const app = await browser();
    const log = recordTransitions(app);
    await app.share([app.file, new File(["second"], "second.txt")]);
    await app.closeEvent("sender_left");
    const second = app.cards.find((card) => card.dataset.channel !== app.payload.id)!;
    await second.querySelector('[data-action="delete"]')!.emit("click");
    await settle();
    expect(log).toEqual(["idle>waiting", "idle>waiting", "waiting>closed", "waiting>paused", "paused>closed"]);
  });

  test("the send page goes idle, waiting, paused and back to waiting, and leaving mid-upload fails the transfer", async () => {
    const page = await browser("sender.js");
    const log = recordTransitions(page);
    const choose = async () => {
      page.nodes.get("#send-file")!.files = [page.file];
      await page.nodes.get("#send-file")!.emit("change");
      await page.nodes.get("#send-form")!.emit("submit");
      await settle();
    };
    await choose();
    await page.nodes.get("#stop-hosting")!.emit("click");
    await settle();
    await choose();
    await page.status({ waitingReceivers: 1 });
    await page.windowEvents.emit("pagehide", { persisted: true });
    await settle();
    expect(log).toEqual(["idle>waiting", "waiting>paused", "paused>waiting", "waiting>uploading", "uploading>failed"]);
    await page.windowEvents.emit("pageshow", { persisted: true });
    await settle();
    expect(page.nodes.get("#send-status")!.textContent).toMatch(/interrupted when this page was left/);
  });
});

describe("page drop overlay", () => {
  test("file drags anywhere show the overlay, survive nested enter and leave, and dropping shares the files", async () => {
    const app = await browser();
    const overlay = app.nodes.get("#drop-overlay")!;
    expect(await app.drag("dragenter")).toBe(true);
    expect(await app.drag("dragenter")).toBe(true);
    expect(overlay.classList.contains("active")).toBe(true);
    await app.drag("dragleave");
    expect(overlay.classList.contains("active")).toBe(true);
    expect(await app.drag("dragover")).toBe(true);
    const files = [new File(["one"], "one.txt"), new File(["two"], "two.txt")];
    expect(await app.drop(files)).toBe(true);
    expect(overlay.classList.contains("active")).toBe(false);
    expect(app.cards.map((card) => card.querySelector(".name")!.textContent)).toEqual(["one.txt", "two.txt"]);
    expect(app.notice()).toBe("2 files added");
  });

  test("dragged text and links are left to the browser and never show the overlay", async () => {
    const app = await browser();
    expect(await app.drag("dragenter", ["text/plain", "text/uri-list"])).toBe(false);
    expect(await app.drag("dragover", ["text/plain"])).toBe(false);
    expect(app.nodes.get("#drop-overlay")!.classList.contains("active")).toBe(false);
    expect(await app.drop([], ["text/plain"])).toBe(false);
    expect(app.cards).toHaveLength(0);
  });

  test("leaving the window with a file drag hides the overlay", async () => {
    const app = await browser();
    await app.drag("dragenter");
    await app.drag("dragleave");
    expect(app.nodes.get("#drop-overlay")!.classList.contains("active")).toBe(false);
  });
});

describe("page status stream", () => {
  test("many shares use one stream with one hosting subscription each and no status polling", async () => {
    const app = await browser();
    await app.share(Array.from({ length: 6 }, (_, index) => new File([`file ${index}`], `file-${index}.txt`)));
    await app.advance(30000);
    expect(app.sources).toHaveLength(1);
    expect(app.sources[0]!.url).toBe("/api/v1/track?format=native");
    const subscribed = app.subscriptions().map((request) => new URL(request.url));
    expect(subscribed).toHaveLength(6);
    expect(new Set(subscribed.map((url) => url.pathname.split("/")[3])).size).toBe(6);
    for (const url of subscribed) {
      expect(url.pathname).toEndWith("/subscribe/tracker-1");
      expect(url.searchParams.get("hosting")).toBe("1");
    }
    expect(app.requests.filter((request) => request.method === "GET")).toHaveLength(0);
  });

  test("while the stream is open a hosting page never renews a presence lease", async () => {
    const app = await browser();
    await app.share([app.file, new File(["second"], "second.txt")]);
    await app.advance(60000);
    await app.reconnect();
    await app.advance(60000);
    await app.status({ waitingReceivers: 1 });
    await app.uploads[0]!.finish();
    await app.advance(60000);
    expect(app.presence()).toHaveLength(0);
    expect(app.leaseHeaders()).toHaveLength(0);
  });

  test("without a stream one batched request renews every hosting share in under 5 s and applies its answer", async () => {
    const app = await browser();
    await app.share([new File(["one"], "one.txt"), new File(["two"], "two.txt"), new File(["three"], "three.txt")]);
    app.silenceNewStreams(true);
    const first = app.stream!;
    first.readyState = 2;
    await first.emit("error");
    await app.advance(0);
    expect(app.presence()).toHaveLength(1);
    const keys = app.presence()[0]!.keys;
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    expect(app.cards.every((card) => !/reconnect/i.test(card.querySelector(".status-text")!.textContent))).toBe(true);
    await app.advance(4000);
    expect(app.presence()).toHaveLength(2);
    app.setPresenceResponse(({ keys: asked }) =>
      Response.json({
        channels: { [asked[2]!]: { ...app.payload, id: asked[2] } },
        closed: { [asked[0]!]: { error: "This share was deleted.", reason: "deleted" } },
        unknown: [asked[1]],
      }),
    );
    await app.advance(4000);
    const [deleted, unknown, live] = keys.map((key: string) => app.cards.find((card) => card.dataset.channel === key)!);
    expect(deleted!.classList.contains("has-error")).toBe(true);
    expect(unknown!.classList.contains("has-error")).toBe(true);
    expect(live!.classList.contains("has-error")).toBe(false);
    await app.advance(4000);
    expect(app.presence().at(-1)!.keys).toEqual([keys[2]]);
    expect(app.leaseHeaders()).toHaveLength(0);
  });

  test("a share added while the stream is reconnecting renews its lease at once, and one opening stream gets a moment first", async () => {
    const app = await browser();
    app.silenceNewStreams(true);
    await app.share();
    await app.advance(0);
    expect(app.presence()).toHaveLength(0);
    const first = app.stream!;
    first.readyState = 2;
    await first.emit("error");
    await app.advance(0);
    expect(app.presence()).toHaveLength(1);
    await app.share([new File(["late"], "late.txt")]);
    await app.advance(0);
    expect(app.presence()).toHaveLength(2);
    expect(app.presence().at(-1)!.keys).toHaveLength(2);
  });

  test("a failed presence renewal shows the share reconnecting until the next one succeeds", async () => {
    const app = await browser();
    await app.share();
    app.silenceNewStreams(true);
    app.setPresenceResponse(() => new Response("Bad gateway", { status: 502 }));
    const first = app.stream!;
    first.readyState = 2;
    await first.emit("error");
    await app.advance(0);
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/reconnect/i);
    app.setPresenceResponse(null);
    await app.advance(4000);
    expect(app.card!.querySelector(".status-text")!.textContent).not.toMatch(/reconnect/i);
  });

  test("the page stream closes once the server has closed its last share, by event or by subscribe answer", async () => {
    const app = await browser();
    await app.share();
    await app.closeEvent("sender_left");
    expect(app.sources.every((source) => source.closed)).toBe(true);
    const other = await browser();
    other.setStatusResponse((url) =>
      url.includes("/subscribe/")
        ? Response.json({ error: "This share was deleted.", reason: "deleted" }, { status: 410 })
        : Response.json(other.payload),
    );
    await other.share();
    expect(other.card!.classList.contains("has-error")).toBe(true);
    expect(other.sources.every((source) => source.closed)).toBe(true);
    expect(other.subscriptions("DELETE")).toHaveLength(0);
  });

  test("after a reconnect the lease is renewed until the hosting subscription is confirmed", async () => {
    const app = await browser();
    await app.share();
    const stream = app.stream!;
    stream.readyState = 0;
    await stream.emit("error");
    await app.advance(0);
    expect(app.presence()).toHaveLength(1);
    let confirm!: (response: Response) => void;
    app.setStatusResponse((url) =>
      url.includes("/subscribe/")
        ? new Promise<Response>((done) => {
            confirm = done;
          })
        : Response.json(app.payload),
    );
    await app.reconnect();
    await app.advance(4000);
    expect(app.presence()).toHaveLength(2);
    confirm(Response.json(app.payload));
    await settle();
    await app.advance(20000);
    expect(app.presence()).toHaveLength(2);
  });

  test("a subscribe that fails on the network keeps the lease and is retried", async () => {
    const app = await browser();
    let fail = true;
    app.setStatusResponse((url) =>
      url.includes("/subscribe/") && fail
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Response.json(app.payload),
    );
    await app.share();
    await app.advance(0);
    expect(app.presence()).toHaveLength(1);
    fail = false;
    await app.advance(1000);
    expect(app.subscriptions()).toHaveLength(2);
    await app.advance(20000);
    expect(app.presence()).toHaveLength(1);
  });

  test("a subscription refused with 429 is retried with backoff while presence covers the share", async () => {
    const app = await browser();
    let refusals = 2;
    app.setStatusResponse((url) =>
      url.includes("/subscribe/") && refusals-- > 0
        ? Response.json({ error: "Too many subscriptions", reason: "tracker_limit", retryable: true }, { status: 429 })
        : Response.json(app.payload),
    );
    await app.share();
    await app.advance(0);
    expect(app.presence()).toHaveLength(1);
    await app.advance(1000);
    expect(app.subscriptions()).toHaveLength(2);
    await app.advance(2000);
    expect(app.subscriptions()).toHaveLength(3);
    const renewed = app.presence().length;
    await app.advance(30000);
    expect(app.presence()).toHaveLength(renewed);
    expect(app.sources.filter((source) => !source.closed)).toHaveLength(1);
    expect(app.card!.classList.contains("has-error")).toBe(false);
  });

  test("a presence batch over the server's limit is resent in pieces of its max, and later batches stay within it", async () => {
    const app = await browser();
    app.setPresenceResponse(({ keys }) =>
      keys.length > 2
        ? Response.json({ error: "Too many keys", reason: "too_many_keys", max: 2, retryable: false }, { status: 400 })
        : Response.json({
            channels: Object.fromEntries(keys.map((key) => [key, { ...app.payload, id: key }])),
            closed: {},
            unknown: [],
          }),
    );
    app.silenceNewStreams(true);
    await app.share([new File(["1"], "1.txt"), new File(["2"], "2.txt"), new File(["3"], "3.txt")]);
    const stream = app.stream!;
    stream.readyState = 2;
    await stream.emit("error");
    await app.advance(0);
    expect(app.presence().map((body) => body.keys.length)).toEqual([3, 2, 1]);
    await app.advance(4000);
    expect(
      app
        .presence()
        .slice(3)
        .map((body) => body.keys.length),
    ).toEqual([2, 1]);
    expect(app.cards.every((card) => !card.classList.contains("has-error"))).toBe(true);
  });

  test("every reconnect resubscribes each live key with its hosting flag", async () => {
    const app = await browser();
    await app.share([app.file, new File(["second"], "second.txt")]);
    await app.reconnect();
    const latest = app
      .subscriptions()
      .slice(-2)
      .map((request) => new URL(request.url));
    expect(latest.map((url) => url.pathname.split("/").at(-1))).toEqual(["tracker-again-1", "tracker-again-1"]);
    expect(latest.every((url) => url.searchParams.get("hosting") === "1")).toBe(true);
  });

  test("a stale tracker answer waits for the next initialization instead of closing the share", async () => {
    const app = await browser();
    app.setStatusResponse((url) =>
      url.includes("/subscribe/")
        ? Response.json({ error: "Tracker not found", reason: "tracker_not_found", retryable: false }, { status: 404 })
        : Response.json(app.payload),
    );
    await app.share();
    expect(app.card!.classList.contains("has-error")).toBe(false);
    app.setStatusResponse(null);
    await app.reconnect();
    await app.status({ waitingReceivers: 1 });
    expect(app.uploads).toHaveLength(1);
  });

  test("a subscription answered 410 closes the share with its reason", async () => {
    const app = await browser();
    app.setStatusResponse(() =>
      Response.json({ error: "The sender stopped sharing this file.", reason: "sender_left" }, { status: 410 }),
    );
    await app.share();
    expect(app.card!.classList.contains("has-error")).toBe(true);
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/sharing stopped/i);
  });

  test("a response snapshot older than a streamed event is ignored", async () => {
    const app = await browser();
    let respond!: (response: Response) => void;
    app.setStatusResponse((url) =>
      url.includes("/subscribe/")
        ? new Promise<Response>((done) => {
            respond = done;
          })
        : Response.json(app.payload),
    );
    await app.share();
    await app.status({ waitingReceivers: 0, activeUpload: true });
    respond(Response.json({ ...app.payload, waitingReceivers: 1, activeUpload: false }));
    await settle();
    expect(app.uploads).toHaveLength(0);
  });

  test("a silent stream is replaced, and meanwhile a hosting page renews its presence in under 5 s", async () => {
    const app = await browser();
    await app.share();
    const first = app.stream!;
    app.silenceNewStreams(true);
    app.context.AirShare.pageStream().lastEvent -= 20000;
    for (const tick of app.intervals) tick();
    await app.advance(0);
    expect(first.closed).toBe(true);
    expect(app.card!.querySelector(".status-text")!.textContent).not.toMatch(/reconnect/i);
    const presence = () => app.presence().length;
    expect(presence()).toBe(1);
    await app.advance(1000);
    expect(app.sources).toHaveLength(2);
    const second = app.stream!;
    expect(second).not.toBe(first);
    await app.advance(3500);
    expect(presence()).toBe(2);
    await second.emit("tracker_event", { data: JSON.stringify({ initialized: { tracker_key: "tracker-2" } }) });
    await settle();
    expect(app.subscriptions().at(-1)!.url).toContain("/subscribe/tracker-2?hosting=1");
    const polled = presence();
    await app.advance(10000);
    expect(presence()).toBe(polled);
  });

  test("a stream refused with a closed EventSource is reopened with backoff instead of staying dead", async () => {
    const app = await browser();
    await app.share();
    const first = app.stream!;
    first.readyState = 2;
    await first.emit("error");
    await settle();
    expect(first.closed).toBe(true);
    await app.advance(900);
    expect(app.sources).toHaveLength(1);
    await app.advance(200);
    expect(app.sources).toHaveLength(2);
  });

  test("page requests use the page origin even when links advertise another public origin", async () => {
    const publicBase = "https://share.example.test";
    const app = await browser("app.js", new Map(), {
      payloadOverrides: {
        statusUrl: `${publicBase}/api/channels/owner-capability`,
        deleteUrl: `${publicBase}/api/channels/owner-capability`,
        uploadUrl: `${publicBase}/api/channels/sender-capability/upload/sample.txt`,
        humanUrl: `${publicBase}/r/receiver-capability`,
      },
    });
    await app.share();
    expect(app.subscriptions()[0]!.url).toStartWith("http://airshare.test/api/channels/owner-capability/subscribe/");
    await app.status({ waitingReceivers: 1 });
    expect(app.uploads[0]!.url).toBe("http://airshare.test/api/channels/sender-capability/upload/sample.txt");
    expect(app.uploads[0]!.headers).not.toHaveProperty("x-airshare-hash");
    await app.card!.querySelector('[data-action="copy-human"]')!.emit("click");
    expect(app.clipboard).toBe(`${publicBase}/r/receiver-capability`);
    await app.windowEvents.emit("pagehide", { persisted: false });
    expect(app.requests.at(-1)!.url).toBe("http://airshare.test/api/channels/owner-capability?reason=sender_left");
  });
});

describe("in-memory share list and page lifecycle", () => {
  test("startup removes the legacy stored share list and sharing never writes browser storage", async () => {
    const storage = new Map([
      ["airshare.shares.v1", JSON.stringify([{ channel: { id: "old-owner" } }])],
      ["unrelated", "kept"],
    ]);
    const app = await browser("app.js", storage);
    expect(storage.has("airshare.shares.v1")).toBe(false);
    expect(storage.get("unrelated")).toBe("kept");
    await app.share();
    expect(app.writes).toHaveLength(0);
    expect([...storage.keys()]).toEqual(["unrelated"]);
  });

  test("a new page with the same browser storage starts with an empty list and no status connections", async () => {
    const first = await browser();
    await first.share();
    expect(first.card).toBeDefined();
    const second = await browser("app.js", first.storage);
    await settle();
    expect(second.card).toBeUndefined();
    expect(second.sources).toHaveLength(0);
    expect(second.requests).toHaveLength(0);
  });

  test("home-page shares are created host-bound and subscribe as hosts while they hold a File", async () => {
    const app = await browser();
    await app.share();
    const create = app.requests.find((request) => request.method === "POST" && request.url === "/api/channels")!;
    expect(JSON.parse(create.body!)).toMatchObject({
      filename: "sample.txt",
      contentLength: app.file.size,
      hostBound: true,
    });
    expect(app.subscriptions()[0]!.url).toBe(
      "http://airshare.test/api/channels/owner-capability/subscribe/tracker-1?hosting=1",
    );
  });

  test("a real unload ends every open share with a keepalive DELETE marked sender_left", async () => {
    const app = await browser();
    await app.share();
    await app.windowEvents.emit("pagehide", { persisted: false });
    await settle();
    const deletes = app.requests.filter((request) => request.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.keepalive).toBe(true);
    const url = new URL(deletes[0]!.url);
    expect(url.pathname).toBe("/api/channels/owner-capability");
    expect(url.searchParams.get("reason")).toBe("sender_left");
    expect(app.sources.every((source) => source.closed)).toBe(true);
  });

  test("a deleted share is not deleted again on unload", async () => {
    const app = await browser();
    await app.share();
    await app.card!.querySelector('[data-action="delete"]')!.emit("click");
    await settle();
    await app.windowEvents.emit("pagehide", { persisted: false });
    await settle();
    expect(
      app.requests.filter((request) => request.method === "DELETE" && !request.url.includes("/subscribe/")),
    ).toHaveLength(1);
  });

  test("entering the back/forward cache only suspends, and restoring reports a share that closed meanwhile", async () => {
    const app = await browser();
    await app.share();
    await app.advance(2000);
    await app.windowEvents.emit("pagehide", { persisted: true });
    await settle();
    expect(app.requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(app.sources.every((source) => source.closed)).toBe(true);
    const before = app.sources.length;
    await app.windowEvents.emit("pageshow", { persisted: true });
    await settle();
    expect(app.sources.length).toBe(before + 1);
    await app.closeEvent("sender_left");
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/stopped/i);
    expect(app.notice()).toBe("sample.txt stopped sharing. Add it again to share it.");
    expect(app.nodes.get("#notice")!.classList.contains("is-error")).toBe(true);
  });

  test("leaving the page asks for confirmation only while a share is live", async () => {
    const app = await browser();
    const leave = async () => {
      let prevented = false;
      await app.windowEvents.emit("beforeunload", {
        preventDefault() {
          prevented = true;
        },
      });
      return prevented;
    };
    expect(await leave()).toBe(false);
    await app.share();
    expect(await leave()).toBe(true);
    await app.card!.querySelector('[data-action="delete"]')!.emit("click");
    await settle();
    expect(await leave()).toBe(false);
  });

  test("a share closed by the server stops counting as live and explains why", async () => {
    const app = await browser();
    await app.share();
    await app.advance(2000);
    await app.closeEvent("deleted");
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/no longer available/i);
    expect(app.notice()).toBe("sample.txt is no longer shared. Add it again to share it.");
    let prevented = false;
    await app.windowEvents.emit("beforeunload", {
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(false);
  });
});

describe("receiver view", () => {
  test("a receiver visiting an already-used link is told it can download, not that its download completed", async () => {
    const page = await browser("receiver.js");
    await page.status({ completedTransfers: 5 });
    expect(page.nodes.get("#receiver-status")!.textContent).toMatch(/ready|available/i);
    expect(page.nodes.get("#download")!.getAttribute("href")).toBe(
      "http://airshare.test/download/receiver-capability/sample.txt",
    );
  });

  test("the receiver polls its status without a stream, from every 2 s backing off to every 10 s", async () => {
    const page = await browser("receiver.js");
    expect(page.sources).toHaveLength(0);
    expect(page.subscriptions()).toHaveLength(0);
    await page.advance(45000);
    const polls = page.requests.filter((request) => request.method === "GET").map((request) => request.at);
    expect(polls[0]).toBe(0);
    const gaps = polls.slice(1).map((at, index) => at - polls[index]!);
    expect(gaps.slice(0, 5)).toEqual([2000, 3000, 4500, 6750, 10000]);
    expect(gaps.slice(5).every((gap) => gap === 10000)).toBe(true);
    expect(page.presence()).toHaveLength(0);
  });

  test("polling pauses while the tab is hidden and restarts at 2 s when it is shown", async () => {
    const page = await browser("receiver.js");
    const gets = () => page.requests.filter((request) => request.method === "GET").length;
    page.document.hidden = true;
    await page.documentEvents.emit("visibilitychange");
    const hidden = gets();
    await page.advance(60000);
    expect(gets()).toBe(hidden);
    page.document.hidden = false;
    await page.documentEvents.emit("visibilitychange");
    await settle();
    expect(gets()).toBe(hidden + 1);
    await page.advance(2000);
    expect(gets()).toBe(hidden + 2);
  });

  test("polling stops once the download has started", async () => {
    const page = await browser("receiver.js");
    await page.nodes.get("#download")!.emit("click");
    const started = page.requests.length;
    await page.advance(60000);
    expect(page.requests).toHaveLength(started);
    expect(page.nodes.get("#receiver-status")!.textContent).toMatch(/browser manages the download/);
  });

  test("a sender_left answer replaces Download with the red alert, says the sender stopped sharing and stops polling", async () => {
    const page = await browser("receiver.js");
    expect(page.nodes.get("#receiver-alert")!.hidden).toBe(false);
    page.setStatusResponse(() =>
      Response.json({ error: "The sender stopped sharing this file.", reason: "sender_left" }, { status: 410 }),
    );
    await page.advance(2000);
    const status = page.nodes.get("#receiver-status")!;
    expect(status.textContent).toBe("The sender stopped sharing this file.");
    expect(status.classList.contains("has-error")).toBe(true);
    expect(page.nodes.get("#receiver-alert")!.hidden).toBe(true);
    expect(page.nodes.get("#download")!.hidden).toBe(true);
    expect(page.nodes.get("#download")!.hasAttribute("href")).toBe(false);
    expect(page.nodes.get("#download")!.getAttribute("aria-disabled")).toBe("true");
    const closed = page.requests.length;
    await page.advance(60000);
    expect(page.requests).toHaveLength(closed);
  });

  for (const [status, body] of [
    [410, { error: "This share was deleted.", reason: "deleted" }],
    [410, { error: "This share expired.", reason: "expired" }],
    [404, undefined],
  ] as const) {
    test(`a ${status}${body ? ` ${body.reason}` : ""} status answer says the share is no longer available`, async () => {
      const page = await browser("receiver.js");
      page.setStatusResponse(() => (body ? Response.json(body, { status }) : new Response("Not found", { status })));
      await page.advance(2000);
      expect(page.nodes.get("#receiver-status")!.textContent).toBe("This share is no longer available.");
      expect(page.nodes.get("#download")!.hasAttribute("href")).toBe(false);
      expect(page.nodes.get("#download")!.hidden).toBe(true);
    });
  }

  test("closing a link while Download has keyboard focus moves focus to the alert that replaces it", async () => {
    const page = await browser("receiver.js");
    const download = page.nodes.get("#download")!;
    const status = page.nodes.get("#receiver-status")!;
    status.focus = () => {
      page.document.activeElement = status;
    };
    page.document.activeElement = download;
    page.setStatusResponse(() =>
      Response.json({ error: "The sender stopped sharing this file.", reason: "sender_left" }, { status: 410 }),
    );
    await page.advance(2000);
    expect(download.hidden).toBe(true);
    expect(status.textContent).toBe("The sender stopped sharing this file.");
    expect(status.getAttribute("tabindex")).toBe("-1");
    expect(page.document.activeElement).toBe(status);
  });

  test("closing a link while focus is elsewhere leaves focus where it is", async () => {
    const page = await browser("receiver.js");
    const status = page.nodes.get("#receiver-status")!;
    status.focus = () => {
      page.document.activeElement = status;
    };
    page.setStatusResponse(() => new Response("Not found", { status: 404 }));
    await page.advance(2000);
    expect(page.nodes.get("#download")!.hidden).toBe(true);
    expect(status.hasAttribute("tabindex")).toBe(false);
    expect(page.document.activeElement).toBeNull();
  });

  test("a failed status poll keeps Download usable and shows a reconnecting warning, not the red alert", async () => {
    const page = await browser("receiver.js");
    page.setStatusResponse(() => new Response("Unavailable", { status: 503 }));
    await page.advance(2000);
    const status = page.nodes.get("#receiver-status")!;
    expect(status.textContent).toBe("Connection lost. Reconnecting to the sender's status.");
    expect(status.classList.contains("is-warning")).toBe(true);
    expect(status.classList.contains("has-error")).toBe(false);
    expect(page.nodes.get("#download")!.hidden).toBe(false);
    expect(page.nodes.get("#download")!.getAttribute("href")).toBe(
      "http://airshare.test/download/receiver-capability/sample.txt",
    );
    page.setStatusResponse(null);
    await page.advance(10000);
    expect(status.classList.contains("is-warning")).toBe(false);
    expect(status.textContent).toMatch(/ready to download/i);
  });

  test("a server-rendered closed link renders its reason without contacting the server", async () => {
    const page = await browser("receiver.js");
    const before = page.requests.length;
    await page.mount("receiver", { key: "receiver-capability", role: "receiver", closedReason: "sender_left" });
    expect(page.nodes.get("#receiver-status")!.textContent).toBe("The sender stopped sharing this file.");
    expect(page.nodes.get("#receiver-alert")!.hidden).toBe(true);
    expect(page.nodes.get("#download")!.hidden).toBe(true);
    await page.advance(30000);
    expect(page.requests).toHaveLength(before);
  });

  test("a receiver view opened without a bootstrap loads the key and rejects another role's key", async () => {
    const page = await browser("receiver.js");
    page.context.AirShare.views.receiver.unmount();
    await page.mount("receiver", null);
    expect(page.requests.filter((request) => request.method === "GET").at(-1)!.url).toBe(
      "/api/channels/receiver-capability",
    );
    expect(page.nodes.get("#receiver-status")!.textContent).toBe("This share is no longer available.");
  });

  test("leaving the receiver view stops polling", async () => {
    const page = await browser("receiver.js");
    page.context.AirShare.views.receiver.unmount();
    await settle();
    const before = page.requests.length;
    await page.advance(30000);
    expect(page.requests.length).toBe(before);
    expect(page.sources).toHaveLength(0);
  });

  test("a file dropped on the receiver view is ignored without leaving the page", async () => {
    const page = await browser("receiver.js", new Map(), { extraScripts: ["app.js"] });
    page.showView("receiver");
    expect(await page.drag("dragenter")).toBe(true);
    expect(page.nodes.get("#drop-overlay")!.classList.contains("active")).toBe(false);
    expect(await page.drop([new File(["dropped"], "dropped.txt")])).toBe(true);
    await settle();
    expect(page.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    expect(page.cards).toHaveLength(0);
  });
});

describe("send view", () => {
  test("a dedicated sender requires Send once then hosts the same File for later receivers", async () => {
    const page = await browser("sender.js");
    await page.status({ waitingReceivers: 1 });
    expect(page.uploads).toHaveLength(0);
    page.nodes.get("#send-file")!.files = [page.file];
    await page.nodes.get("#send-file")!.emit("change");
    await settle();
    expect(page.uploads).toHaveLength(0);
    expect(page.subscriptions().map((request) => new URL(request.url).searchParams.get("hosting"))).toEqual(["0"]);
    let prevented = false;
    await page.nodes.get("#send-form")!.emit("submit", {
      preventDefault() {
        prevented = true;
      },
    });
    await settle();
    expect(prevented).toBe(true);
    expect(page.uploads).toHaveLength(1);
    expect(page.subscriptions().at(-1)!.url).toContain("hosting=1");
    await page.nodes.get("#send-form")!.emit("submit");
    expect(page.uploads).toHaveLength(1);
    await page.status({ waitingReceivers: 0, activeUpload: false, completedTransfers: 1 });
    await page.uploads[0]!.finish();
    await page.status({ waitingReceivers: 1 });
    expect(page.uploads).toHaveLength(2);
    expect(page.uploads[1]!.body).toBe(page.file);
  });

  test("after Send the progress bar sits in the form, resets after each upload and says Upload completed", async () => {
    const page = await browser("sender.js");
    const progress = page.nodes.get("#send-progress")!;
    const bar = page.nodes.get("#transfer-progress")!;
    expect(progress.hidden).toBe(true);
    page.nodes.get("#send-file")!.files = [page.file];
    await page.nodes.get("#send-file")!.emit("change");
    expect(progress.hidden).toBe(true);
    expect(page.nodes.get("#send-note")!.hidden).toBe(true);
    await page.nodes.get("#send-form")!.emit("submit");
    await settle();
    expect(progress.hidden).toBe(false);
    expect(page.nodes.get("#send-note")!.hidden).toBe(false);
    await page.status({ waitingReceivers: 1 });
    await page.uploads[0]!.upload.emit("progress", { lengthComputable: true, loaded: 5, total: 20 });
    expect(bar.style.width).toBe("25%");
    await page.status({ waitingReceivers: 0, activeUpload: false, completedTransfers: 1 });
    await page.uploads[0]!.finish();
    expect(bar.style.width).toBe("0%");
    expect(page.notice()).toBe("Upload completed");
    expect(progress.hidden).toBe(false);
  });

  test("stopping a dedicated sender without a stream releases its presence lease", async () => {
    const page = await browser("sender.js");
    page.silenceNewStreams(true);
    const first = page.stream!;
    first.readyState = 2;
    await first.emit("error");
    page.nodes.get("#send-file")!.files = [page.file];
    await page.nodes.get("#send-file")!.emit("change");
    expect(page.presence()).toHaveLength(0);
    await page.nodes.get("#send-form")!.emit("submit");
    await page.advance(0);
    expect(page.presence().map((body) => body.keys)).toEqual([[page.payload.id]]);
    await page.nodes.get("#stop-hosting")!.emit("click");
    await settle();
    expect(page.presence(false).map((body) => body.keys)).toEqual([[page.payload.id]]);
    await page.advance(20000);
    expect(page.presence()).toHaveLength(1);
  });

  test("a file dropped on the Send view fills its form instead of creating a share", async () => {
    const page = await browser("sender.js", new Map(), { extraScripts: ["app.js"] });
    page.showView("send");
    const overlay = page.nodes.get("#drop-overlay")!;
    expect(await page.drag("dragenter")).toBe(true);
    expect(overlay.classList.contains("active")).toBe(true);
    expect(overlay.querySelector("p")!.textContent).toBe("Drop your file to send it");
    const dropped = new File(["dropped bytes"], "dropped.bin");
    expect(await page.drop([dropped])).toBe(true);
    expect(overlay.classList.contains("active")).toBe(false);
    expect(page.nodes.get("#send-button")!.disabled).toBe(false);
    expect(page.uploads).toHaveLength(0);
    await page.nodes.get("#send-form")!.emit("submit");
    await settle();
    await page.status({ waitingReceivers: 1 });
    expect(page.uploads).toHaveLength(1);
    expect(page.uploads[0]!.body).toBe(dropped);
    expect(
      page.requests.filter((request) => request.method === "POST" && /\/api\/channels$/.test(request.url)),
    ).toHaveLength(0);
    expect(page.cards).toHaveLength(0);
    page.showView("home");
    await page.drag("dragenter");
    expect(overlay.querySelector("p")!.textContent).toBe("Drop your file to share it");
  });

  test("stopping a dedicated sender releases the file picker and drops its hosting subscription", async () => {
    const page = await browser("sender.js");
    await page.status({ waitingReceivers: 1 });
    page.nodes.get("#send-file")!.files = [page.file];
    await page.nodes.get("#send-file")!.emit("change");
    await page.nodes.get("#send-form")!.emit("submit");
    await settle();
    expect(page.nodes.get("#send-file")!.disabled).toBe(true);
    await page.nodes.get("#stop-hosting")!.emit("click");
    await settle();
    expect(page.nodes.get("#send-file")!.disabled).toBe(false);
    expect(page.nodes.get("#send-status")!.textContent).toMatch(/hosting stopped/i);
    expect(page.nodes.get("#send-note")!.hidden).toBe(true);
    expect(page.subscriptions("DELETE")).toHaveLength(1);
    await page.nodes.get("#send-form")!.emit("submit");
    await settle();
    expect(page.uploads).toHaveLength(1);
  });

  test("a submitted sender automatically recovers a cancelled receiver without another Send", async () => {
    const page = await browser("sender.js");
    await page.status({ waitingReceivers: 1 });
    page.nodes.get("#send-file")!.files = [page.file];
    await page.nodes.get("#send-file")!.emit("change");
    await page.nodes.get("#send-form")!.emit("submit");
    await settle();
    expect(page.uploads).toHaveLength(1);
    await page.uploads[0]!.finish(
      409,
      JSON.stringify({ error: "Receiver left", reason: "no_receivers", retryable: true }),
    );
    await page.advance(6000);
    expect(page.uploads).toHaveLength(2);
    expect(page.uploads[1]!.body).toBe(page.file);
  });

  test("hosting continues while another view is shown and the view resumes its state when shown again", async () => {
    const page = await browser("sender.js");
    page.nodes.get("#send-file")!.files = [page.file];
    await page.nodes.get("#send-file")!.emit("change");
    await page.nodes.get("#send-form")!.emit("submit");
    await settle();
    const views = page.context.AirShare.views;
    views.send.unmount();
    expect(views.send.liveCount()).toBe(1);
    await page.status({ waitingReceivers: 1 });
    expect(page.uploads).toHaveLength(1);
    expect(page.uploads[0]!.body).toBe(page.file);
    page.nodes.get("#send-status")!.textContent = "stale";
    await page.mount("send", {
      key: "sender-capability",
      role: "sender",
      channel: { ...page.payload, role: "sender" },
    });
    expect(page.nodes.get("#send-status")!.textContent).toMatch(/uploading/i);
    expect(page.sources.filter((source) => !source.closed)).toHaveLength(1);
  });

  test("a closed request page disables sending and explains why", async () => {
    const page = await browser("sender.js");
    await page.context.AirShare.views.send.mount({
      key: "gone-capability",
      bootstrap: { key: "gone-capability", role: "sender", closedReason: "expired" },
    });
    await settle();
    expect(page.nodes.get("#send-status")!.textContent).toBe("This share is no longer available.");
    expect(page.nodes.get("#send-button")!.disabled).toBe(true);
    expect(page.nodes.get("#send-file")!.disabled).toBe(true);
  });

  test("leaving the page asks for confirmation while a requested file is being hosted", async () => {
    const page = await browser("sender.js");
    const leave = async () => {
      let prevented = false;
      await page.windowEvents.emit("beforeunload", {
        preventDefault() {
          prevented = true;
        },
      });
      return prevented;
    };
    expect(await leave()).toBe(false);
    page.nodes.get("#send-file")!.files = [page.file];
    await page.nodes.get("#send-file")!.emit("change");
    await page.nodes.get("#send-form")!.emit("submit");
    await settle();
    expect(await leave()).toBe(true);
    await page.nodes.get("#stop-hosting")!.emit("click");
    expect(await leave()).toBe(false);
  });
});
function routerPage(path = "/", initialView = "home", bootstrap: Record<string, unknown> | null = null) {
  const sections = ["home", "recipes", "about", "privacy", "license", "receiver", "send", "notfound"].map((view) => {
    const section = new Element();
    section.dataset.view = view;
    section.hidden = view !== initialView;
    return section;
  });
  const navigation = ["home", "recipes", "about"].map((name) => {
    const link = new Element();
    link.dataset.nav = name;
    return link;
  });
  const calls: string[] = [];
  const view = (name: string) => ({
    mount: ({ key }: { key: string }) => {
      calls.push(`${name}:mount:${key}`);
    },
    unmount: () => {
      calls.push(`${name}:unmount`);
    },
  });
  const location = new URL(`http://airshare.test${path}`);
  const history = {
    state: null as unknown,
    scrollRestoration: "auto",
    pushed: [] as string[],
    pushState(state: unknown, _title: string, url: string) {
      this.state = state;
      location.href = new URL(url, location.href).href;
      this.pushed.push(url);
    },
    replaceState(state: unknown) {
      this.state = state;
    },
  };
  const documentEvents = new Events();
  const windowEvents = new Events();
  const document = {
    title: "",
    querySelectorAll(selector: string) {
      return selector === "[data-view]" ? sections : selector === "[data-nav]" ? navigation : [];
    },
    querySelector(selector: string) {
      if (selector === "[data-view]:not([hidden])") return sections.find((section) => !section.hidden) ?? null;
      if (selector === "#content") return { focus() {} };
      return null;
    },
    getElementById() {
      return null;
    },
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
  };
  const context = createContext({
    document,
    location,
    history,
    URL,
    console,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    scrollTo() {},
    scrollY: 0,
    AirShare: { readBootstrap: () => bootstrap, views: { receiver: view("receiver"), send: view("send") } },
  });
  context.window = context;
  runInContext(readFileSync(new URL("../public/router.js", import.meta.url), "utf8"), context);
  return {
    calls,
    history,
    document,
    location,
    windowEvents,
    visible: () => sections.filter((section) => !section.hidden).map((section) => section.dataset.view),
    active: () => navigation.filter((link) => link.classList.contains("active")).map((link) => link.dataset.nav),
    async click(href: string, options: { target?: string; download?: boolean; ctrlKey?: boolean } = {}) {
      const link = {
        href: new URL(href, location.href).href,
        target: options.target ?? "",
        hasAttribute: (name: string) => name === "download" && Boolean(options.download),
      };
      let prevented = false;
      const event = {
        button: 0,
        ctrlKey: Boolean(options.ctrlKey),
        metaKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        target: { closest: () => link },
        preventDefault() {
          prevented = true;
        },
      };
      await documentEvents.emit("click", event);
      return prevented;
    },
    async back(path: string, state: unknown = { scrollY: 0 }) {
      location.href = new URL(path, location.href).href;
      await windowEvents.emit("popstate", { state });
    },
  };
}

describe("in-page navigation", () => {
  test("internal links switch views, titles and the active nav entry without loading a page", async () => {
    const page = routerPage();
    expect(page.document.title).toBe("AirShare");
    expect(await page.click("/recipes")).toBe(true);
    expect(page.history.pushed).toEqual(["/recipes"]);
    expect(page.visible()).toEqual(["recipes"]);
    expect(page.document.title).toBe("AirShare Recipes");
    expect(page.active()).toEqual(["recipes"]);
    for (const [href, title] of [
      ["/about", "AirShare About"],
      ["/privacy", "AirShare Privacy"],
      ["/license", "AirShare License"],
    ]) {
      expect(await page.click(href!)).toBe(true);
      expect(page.document.title).toBe(title!);
    }
    expect(page.active()).toEqual([]);
    await page.back("/");
    expect(page.visible()).toEqual(["home"]);
    expect(page.document.title).toBe("AirShare");
    expect(page.active()).toEqual(["home"]);
  });

  test("downloads, other origins, new tabs, modified clicks and non-view paths keep native navigation", async () => {
    const page = routerPage();
    expect(await page.click("https://example.com/recipes")).toBe(false);
    expect(await page.click("/recipes", { target: "_blank" })).toBe(false);
    expect(await page.click("/recipes", { ctrlKey: true })).toBe(false);
    expect(await page.click("/download/receiver/file.txt")).toBe(false);
    expect(await page.click("/download/receiver/file.txt", { download: true })).toBe(false);
    expect(await page.click("/fonts/Lato-OFL.txt")).toBe(false);
    expect(await page.click("/#transfers")).toBe(false);
    expect(page.history.pushed).toEqual([]);
    expect(page.visible()).toEqual(["home"]);
  });

  test("receiver and send views mount for their key and unmount when another view is shown", async () => {
    const page = routerPage("/send/sender-key", "send", { key: "sender-key", role: "sender" });
    expect(page.document.title).toBe("AirShare Upload");
    expect(page.calls).toEqual(["send:mount:sender-key"]);
    expect(await page.click("/recipes")).toBe(true);
    expect(page.calls.at(-1)).toBe("send:unmount");
    await page.back("/send/sender-key");
    expect(page.calls.at(-1)).toBe("send:mount:sender-key");
    expect(page.visible()).toEqual(["send"]);
    expect(await page.click("/r/receiver-key")).toBe(true);
    expect(page.calls.slice(-2)).toEqual(["send:unmount", "receiver:mount:receiver-key"]);
    expect(page.document.title).toBe("AirShare Download");
  });

  test("a server-rendered 404 keeps its view, and returning to it from history shows it again", async () => {
    const page = routerPage("/missing", "notfound");
    expect(page.document.title).toBe("AirShare Page Not Found");
    expect(page.visible()).toEqual(["notfound"]);
    expect(await page.click("/about")).toBe(true);
    expect(page.visible()).toEqual(["about"]);
    await page.back("/missing");
    expect(page.visible()).toEqual(["notfound"]);
    expect(page.document.title).toBe("AirShare Page Not Found");
  });
});

describe("shell pages served by the relay", () => {
  const servers: RunningServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((instance) => instance.close()));
  });
  async function server() {
    const instance = await startServer();
    servers.push(instance);
    return instance;
  }
  const html = { accept: "text/html,application/xhtml+xml" };
  const visibleViews = (page: string) =>
    [...page.matchAll(/data-view="([a-z]+)"(?! hidden)/g)].map((match) => match[1]);
  const bootstrap = (page: string) =>
    JSON.parse(page.match(/<script type="application\/json" id="airshare-channel">([^<]*)<\/script>/)![1]!);

  test("every page is the same shell with its own view, title, nav state, security headers and no inline script", async () => {
    const app = await server();
    for (const [path, title, view] of [
      ["/", "AirShare", "home"],
      ["/recipes", "AirShare Recipes", "recipes"],
      ["/about", "AirShare About", "about"],
      ["/privacy", "AirShare Privacy", "privacy"],
      ["/license", "AirShare License", "license"],
    ] as const) {
      const response = await fetch(`${app.base}${path}`, { headers: html });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      const page = await response.text();
      expect(page).toContain(`<title>${title}</title>`);
      expect(visibleViews(page)).toEqual([view]);
      // Header (home, recipes, about) and footer (privacy, license) links are marked before any script runs.
      expect(
        [...page.matchAll(/data-nav="([a-z]+)" class="active" aria-current="page"/g)].map((match) => match[1]),
      ).toEqual([view]);
      expect(page.match(/class="active"/g)).toHaveLength(1);
      for (const tag of page.match(/<script[^>]*>/g)!)
        expect(tag).toMatch(/\bsrc="\/[a-z]+\.js"|type="application\/json"/);
      expect(page).not.toMatch(/\son[a-z]+=/i);
      expect(page).not.toContain("{{");
      expect(page).toContain(`"${app.base}/xfr`);
    }
    const missing = await (await fetch(`${app.base}/no-such-page`, { headers: html })).text();
    expect(missing).not.toMatch(/data-nav="[a-z]+" class="active"/);
  });

  test("receiver and send pages bootstrap only their own capability as JSON data", async () => {
    const app = await server();
    const owner = await createChannel(app, { filename: "report <draft>.txt", contentLength: 5 });
    const senderKey = new URL(owner.uploadUrl).pathname.split("/")[2]!;
    const receiverKey = new URL(owner.downloadUrl).pathname.split("/")[2]!;
    const receiving = await fetch(owner.humanUrl, { headers: html });
    expect(receiving.status).toBe(200);
    const receiver = await receiving.text();
    expect(receiver).toContain("<title>AirShare Download</title>");
    expect(visibleViews(receiver)).toEqual(["receiver"]);
    expect(receiver).toContain('id="receiver-file-name">report &lt;draft&gt;.txt<');
    expect(receiver).toContain(`id="download" class="primary" href="${owner.downloadUrl}"`);
    expect(bootstrap(receiver)).toMatchObject({
      key: receiverKey,
      role: "receiver",
      channel: { role: "receiver", downloadUrl: owner.downloadUrl },
    });
    expect(receiver).not.toContain(owner.id);
    expect(receiver).not.toContain(senderKey);
    const sending = await (await fetch(`${app.base}/send/${senderKey}`, { headers: html })).text();
    expect(sending).toContain("<title>AirShare Upload</title>");
    expect(visibleViews(sending)).toEqual(["send"]);
    expect(bootstrap(sending)).toMatchObject({ key: senderKey, role: "sender", channel: { role: "sender" } });
    expect(sending).not.toContain(owner.id);
    const wrongRole = await fetch(`${app.base}/send/${receiverKey}`, { headers: html });
    expect(wrongRole.status).toBe(404);
    expect(bootstrap(await wrongRole.text())).toEqual({ key: receiverKey, role: "sender", closedReason: "not_found" });
  });

  test("closed and unknown links render the receiver view with the reason and a matching status", async () => {
    const app = await server();
    const deleted = await createChannel(app, { filename: "deleted.txt" });
    expect((await fetch(deleted.deleteUrl, { method: "DELETE" })).status).toBe(204);
    const deletedPage = await fetch(deleted.humanUrl, { headers: html });
    expect(deletedPage.status).toBe(410);
    const deletedHtml = await deletedPage.text();
    expect(bootstrap(deletedHtml).closedReason).toBe("deleted");
    expect(deletedHtml).toContain(
      'class="transfer-status has-error" role="status" aria-live="polite">This share is no longer available.</p>',
    );
    expect(deletedHtml).not.toContain("deleted.txt");
    const left = await createChannel(app, { filename: "left.txt" });
    expect((await fetch(`${left.deleteUrl}?reason=sender_left`, { method: "DELETE" })).status).toBe(204);
    const leftHtml = await (await fetch(left.humanUrl, { headers: html })).text();
    expect(bootstrap(leftHtml).closedReason).toBe("sender_left");
    expect(leftHtml).toContain(">The sender stopped sharing this file.</p>");
    const unknown = await fetch(`${app.base}/r/not-a-real-key`, { headers: html });
    expect(unknown.status).toBe(404);
    expect(bootstrap(await unknown.text()).closedReason).toBe("not_found");
  });

  test("browsers get the styled 404 while other clients keep the plain one", async () => {
    const app = await server();
    const styled = await fetch(`${app.base}/no-such-page`, { headers: html });
    expect(styled.status).toBe(404);
    expect(styled.headers.get("content-security-policy")).toContain("script-src 'self'");
    const page = await styled.text();
    expect(page).toContain("<title>AirShare Page Not Found</title>");
    expect(visibleViews(page)).toEqual(["notfound"]);
    for (const text of [
      "Uhoh!",
      "404 Page Not Found",
      "The page you requested does not exist!",
      'aria-label="Primary"',
      'class="footer"',
    ])
      expect(page).toContain(text);
    const plain = await fetch(`${app.base}/no-such-page`);
    expect(plain.status).toBe(404);
    expect(await plain.text()).toBe("Not found");
    const head = await fetch(`${app.base}/recipes`, { method: "HEAD", headers: html });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("raw HTML files are never served statically, whatever their case", async () => {
    const app = await server();
    const home = await fetch(`${app.base}/index.html`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(visibleViews(await home.text())).toEqual(["home"]);
    for (const path of ["/INDEX.HTML", "/Index.html", "/index.htm", "/%69ndex.HTML", "/recipes.html"]) {
      const plain = await fetch(`${app.base}${path}`);
      expect(plain.status).toBe(404);
      expect(await plain.text()).toBe("Not found");
      const styled = await fetch(`${app.base}${path}`, { headers: html });
      expect(styled.status).toBe(404);
      expect(styled.headers.get("content-security-policy")).toContain("script-src 'self'");
      const page = await styled.text();
      expect(visibleViews(page)).toEqual(["notfound"]);
      expect(page).not.toContain("{{");
    }
    const asset = await fetch(`${app.base}/styles.css`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/css");
  });
});
