import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

class Events {
  listeners = new Map<string, Array<(event: any) => unknown>>();
  addEventListener(type: string, listener: (event: any) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: any) => unknown) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }
  emit(type: string, values: Record<string, unknown> = {}) {
    return Promise.allSettled((this.listeners.get(type) ?? []).map((listener) => listener({ type, target: this, currentTarget: this, preventDefault() {}, ...values })));
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
  classList = { add() {}, remove() {}, toggle() {} };
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
    const key = selector === '[data-action="open"]' ? '[data-field="url"]' : selector;
    if (!this.nodes.has(key)) {
      const element = new Element();
      element.tagName = key === '[data-field="url"]' ? "A" : key === '[data-action="resume-file"]' ? "INPUT" : key.startsWith("[data-action=") ? "BUTTON" : "DIV";
      this.nodes.set(key, element);
    }
    return this.nodes.get(key)!;
  }
  querySelectorAll() { return []; }
  append(...children: Element[]) {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  appendChild(child: Element) { this.append(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  cloneNode() { return new Element(); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  focus() {}
  select() {}
  setSelectionRange() {}
  click() { return this.emit("click"); }
  showModal() { this.open = true; }
  close() { this.open = false; return this.emit("close"); }
  closest(selector: string): Element | null {
    const tags = selector.split(",").map((tag) => tag.trim().toUpperCase());
    for (let element: Element | null = this; element; element = element.parent) {
      if (tags.includes(element.tagName)) return element;
    }
    return null;
  }
  contains(child: Element) { return this.children.includes(child); }
}

const settle = async () => { for (let index = 0; index < 16; index += 1) await Promise.resolve(); };

function browser(page = "app.js", storage = new Map<string, string>()) {
  const file = new File(["sample file contents"], "sample.txt", { type: "text/plain" });
  const payload = {
    id: "owner-capability", role: "owner",
    file: { filename: file.name, contentLength: file.size, contentType: file.type },
    uploadUrl: "http://airshare.test/api/channels/sender-capability/upload/sample.txt",
    downloadUrl: "http://airshare.test/download/receiver-capability/sample.txt",
    humanUrl: "http://airshare.test/r/receiver-capability",
    eventsUrl: "http://airshare.test/api/channels/owner-capability/events",
    statusUrl: "http://airshare.test/api/channels/owner-capability",
    deleteUrl: "http://airshare.test/api/channels/owner-capability",
    waitingReceivers: 0, activeUpload: false, completedTransfers: 0,
  };
  let serverStatus: Record<string, unknown> = { ...payload };
  const nodes = new Map<string, Element>();
  for (const id of ["file-selector", "drop-zone", "shared-files", "file-template", "status", "download", "send-file", "send-form", "send-button", "notice", "share-dialog", "share-url", "share-qr", "share-caption", "share-feedback", "share-close", "share-copy", "stop-hosting", "retry-transfer", "transfer-progress", "file-name", "file-size", "share-link"]) {
    nodes.set(`#${id}`, new Element());
  }
  for (const id of ["file-selector", "send-file", "share-url"]) nodes.get(`#${id}`)!.tagName = "INPUT";
  for (const id of ["send-button", "share-close", "share-copy", "stop-hosting", "retry-transfer"]) nodes.get(`#${id}`)!.tagName = "BUTTON";
  nodes.get("#send-form")!.tagName = "FORM";
  nodes.get("#share-dialog")!.tagName = "DIALOG";
  nodes.get("#share-qr")!.tagName = "IMG";
  nodes.get("#file-template")!.content = { firstElementChild: new Element() };
  const body = new Element();
  const sources: EventSourceDouble[] = [];
  const uploads: XhrDouble[] = [];
  let clipboard = "";
  class EventSourceDouble extends Events {
    readyState = 1;
    closed = false;
    constructor(public url: string) { super(); sources.push(this); }
    close() { this.closed = true; this.readyState = 2; }
  }
  class XhrDouble extends Events {
    upload = new Events();
    status = 0;
    responseText = "";
    body: unknown;
    url = "";
    headers: Record<string, string> = {};
    open(_method: string, url: string) { this.url = String(url); }
    setRequestHeader(name: string, value: string) { this.headers[name] = value; }
    send(value: unknown) { this.body = value; uploads.push(this); }
    abort() { void this.emit("abort"); }
    async finish(status = 204, text = "") {
      this.status = status;
      this.responseText = text;
      await this.emit("load");
      await settle();
    }
  }
  const document = {
    body, activeElement: null as Element | null,
    querySelector(selector: string) {
      if (selector === ".empty") return nodes.get("#shared-files")!.children.find((child) => child.className === "empty") ?? null;
      return nodes.get(selector) ?? null;
    },
    querySelectorAll() { return []; },
    createElement(tag: string) {
      const element = new Element();
      element.tagName = tag.toUpperCase();
      element.focus = () => { document.activeElement = element; };
      element.select = () => { document.activeElement = element; };
      return element;
    },
    execCommand(command: string) {
      if (command !== "copy") return false;
      clipboard = document.activeElement?.value ?? "";
      return Boolean(clipboard);
    },
  };
  const windowEvents = new Events();
  const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  let nextTimer = 1;
  let now = 0;
  const timers = new Map<number, () => unknown>();
  const timerDue = new Map<number, number>();
  const context = createContext({
    document, navigator: { onLine: true }, console, URL, Response, File, DOMException, AbortController, crypto,
    EventSource: EventSourceDouble, XMLHttpRequest: XhrDouble,
    location: { origin: "http://airshare.test", href: "http://airshare.test/" },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    fetch: async (url: string, options: { method?: string; headers?: Record<string, string> } = {}) => {
      requests.push({ url: String(url), method: options.method || "GET", headers: options.headers || {} });
      if (options.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(options.method === "POST" ? payload : serverStatus);
    },
    alert() {},
    setTimeout: (callback: () => unknown, delay: number) => { const id = nextTimer++; timers.set(id, callback); timerDue.set(id, now + delay); return id; },
    clearTimeout: (id: number) => { timers.delete(id); timerDue.delete(id); }, setInterval: () => 1, clearInterval() {}, queueMicrotask,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    STATION_CHANNEL: payload, AIRSHARE_CHANNEL: payload,
  });
  context.window = context;
  const helper = new URL("../public/transfer.js", import.meta.url);
  if (existsSync(helper)) runInContext(readFileSync(helper, "utf8"), context);
  runInContext(readFileSync(new URL(`../public/${page}`, import.meta.url), "utf8"), context);
  return {
    file, payload, nodes, uploads, sources, context, storage, timers, windowEvents, requests,
    get clipboard() { return clipboard; },
    get card() { return nodes.get("#shared-files")!.children.find((child) => child.dataset.channel); },
    async advance(milliseconds: number) {
      const end = now + milliseconds;
      while (true) {
        const next = Array.from(timerDue).filter((entry) => entry[1] <= end).sort((a, b) => a[1] - b[1])[0];
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
    async share() {
      nodes.get("#file-selector")!.files = [file];
      await nodes.get("#file-selector")!.emit("change");
      await settle();
    },
    async status(values: Record<string, unknown>) {
      serverStatus = { ...serverStatus, ...values };
      const source = sources.filter((item) => !item.closed).at(-1);
      if (source) await source.emit("status", { data: JSON.stringify(serverStatus) });
      else {
        await settle();
        const [id, callback] = timers.entries().next().value!;
        timers.delete(id);
        timerDue.delete(id);
        callback();
      }
      await settle();
    },
  };
}

describe("browser transfer lifecycle", () => {
  test("the visible URL is the live direct-download link while share-copy retains the receiver page", async () => {
    const app = browser();
    await app.share();
    const link = app.card!.querySelector('[data-field="url"]')!;
    expect(link.textContent).toBe("http://airshare.test/download/receiver-capability/sample.txt");
    expect(link.href).toBe("http://airshare.test/download/receiver-capability/sample.txt");
    await app.status({ downloadUrl: "http://airshare.test/download/receiver-capability/renamed.txt" });
    expect(link.textContent).toBe("http://airshare.test/download/receiver-capability/renamed.txt");
    expect(link.href).toBe("http://airshare.test/download/receiver-capability/renamed.txt");
    await app.card!.querySelector('[data-action="copy-direct"]')!.emit("click");
    expect(app.clipboard).toBe("http://airshare.test/download/receiver-capability/renamed.txt");
    await app.card!.querySelector('[data-action="copy-human"]')!.emit("click");
    expect(app.clipboard).toBe("http://airshare.test/r/receiver-capability");
  });

  test("ordinary notices disappear and a newer notice gets its own display interval", async () => {
    const app = browser();
    await app.share();
    expect(app.nodes.get("#notice")!.textContent.length).toBeGreaterThan(0);
    await app.advance(4500);
    expect(app.nodes.get("#notice")!.textContent).toBe("");
    await app.card!.querySelector('[data-action="copy-direct"]')!.emit("click");
    await app.advance(3000);
    await app.card!.querySelector('[data-action="copy-human"]')!.emit("click");
    await app.advance(1500);
    expect(app.nodes.get("#notice")!.textContent).toMatch(/copied/i);
    await app.advance(3000);
    expect(app.nodes.get("#notice")!.textContent).toBe("");
  });

  test("a copy error is not cleared by the preceding success notice's timer", async () => {
    const app = browser();
    await app.share();
    await app.advance(2000);
    app.context.document.execCommand = () => false;
    await app.card!.querySelector('[data-action="copy-human"]')!.emit("click");
    await app.advance(10000);
    expect(app.nodes.get("#notice")!.textContent).toMatch(/could not copy/i);
  });

  test("the QR overlay uses a local image, closes on its image and restores the trigger focus", async () => {
    const app = browser();
    await app.share();
    const trigger = app.card!.querySelector('[data-action="qr"]')!;
    let restoredFocus = false;
    trigger.focus = () => { restoredFocus = true; };
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
    const app = browser();
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

  test("keeps upload failures visible after cleanup and later status updates", async () => {
    const app = browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.uploads[0]!.finish(503, "Receiver disconnected");
    await app.status({ waitingReceivers: 0, activeUpload: false });
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/failed.*receiver disconnected/i);
    expect(app.uploads).toHaveLength(1);
  });

  test("adding another file does not erase a preceding file's creation error", async () => {
    const app = browser();
    app.context.fetch = async (_url: string, options: { method?: string; body?: string } = {}) => {
      if (options.method === "POST" && JSON.parse(options.body!).filename === "sample.txt") {
        return Response.json({ error: "Channel limit reached" }, { status: 503 });
      }
      return Response.json(app.payload);
    };
    app.nodes.get("#file-selector")!.files = [app.file, new File(["second"], "second.txt")];
    await app.nodes.get("#file-selector")!.emit("change");
    await settle();
    expect(app.card).toBeDefined();
    expect(app.nodes.get("#notice")!.textContent).toContain("sample.txt");
    expect(app.nodes.get("#notice")!.textContent).toContain("Channel limit reached");
  });

  test("stopping an upload cannot resurrect its removed card through a late callback", async () => {
    const app = browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.card!.querySelector('[data-action="delete"]')!.emit("click");
    await settle();
    expect(app.card).toBeUndefined();
    await app.sources[0]!.emit("status", { data: JSON.stringify({ waitingReceivers: 1 }) });
    await settle();
    expect(app.card).toBeUndefined();
    expect(app.uploads).toHaveLength(1);
  });

  test("copies a share link on HTTP where the Clipboard API is unavailable", async () => {
    const app = browser();
    await app.share();
    await app.card!.querySelector('[data-action="copy-human"]')!.emit("click");
    await settle();
    expect(app.clipboard).toBe("http://airshare.test/r/receiver-capability");
  });

  test("shows loss of the status connection and recovers when status returns", async () => {
    const app = browser();
    await app.share();
    await app.sources[0]!.emit("error");
    await settle();
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/reconnect|connection/i);
    await app.status({ waitingReceivers: 0 });
    expect(app.card!.querySelector(".status-text")!.textContent).not.toMatch(/reconnect/i);
  });

  test("a receiver visiting an already-used link is told it can download, not that its download completed", async () => {
    const page = browser("receiver.js");
    await page.status({ completedTransfers: 5 });
    expect(page.nodes.get("#status")!.textContent).toMatch(/ready|available/i);
  });

  test("status polling reserves browser connections by running at most two requests at once", async () => {
    const app = browser();
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    app.context.fetch = (_url: string, options: { signal: AbortSignal }) => new Promise<Response>((resolve, reject) => {
      active += 1;
      peak = Math.max(peak, active);
      const release = () => { active -= 1; resolve(Response.json(app.payload)); };
      releases.push(release);
      options.signal.addEventListener("abort", () => { active -= 1; reject(options.signal.reason); }, { once: true });
    });
    const connections = Array.from({ length: 7 }, () => new app.context.AirShare.ChannelConnection(app.payload, () => {}, { useEvents: false }));
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
    const app = browser();
    let started = 0;
    app.context.fetch = (_url: string, options: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      started += 1;
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
    const connections = Array.from({ length: 4 }, () => new app.context.AirShare.ChannelConnection(app.payload, () => {}, { useEvents: false }));
    for (const connection of connections) connection.connect();
    await settle();
    expect(started).toBe(2);
    await app.advance(12000);
    expect(started).toBeGreaterThanOrEqual(4);
    expect(connections[0].reconnecting).toBe(true);
    for (const connection of connections) connection.disconnect();
    await settle();
  });

  test("sender presence is advertised only while the browser actually retains a selected File", async () => {
    const app = browser();
    await app.share();
    expect(new URL(app.sources[0]!.url).searchParams.get("hosting")).toBe("1");
    expect(app.requests.some((request) => request.headers["x-airshare-sender-presence"] === "1")).toBe(true);
    const restored = browser("app.js", app.storage);
    await settle();
    expect(new URL(restored.sources[0]!.url).searchParams.has("hosting")).toBe(false);
    expect(restored.requests.some((request) => request.headers["x-airshare-sender-presence"] === "1")).toBe(false);
  });

  test("a dedicated sender requires Send once then hosts the same File for later receivers", async () => {
    const page = browser("sender.js");
    await page.status({ waitingReceivers: 1 });
    expect(page.uploads).toHaveLength(0);
    page.nodes.get("#send-file")!.files = [page.file];
    await page.nodes.get("#send-file")!.emit("change");
    await settle();
    expect(page.uploads).toHaveLength(0);
    expect(page.sources.filter((source) => !source.closed).some((source) => new URL(source.url).searchParams.has("hosting"))).toBe(false);
    let prevented = false;
    await page.nodes.get("#send-form")!.emit("submit", { preventDefault() { prevented = true; } });
    await settle();
    expect(prevented).toBe(true);
    expect(page.uploads).toHaveLength(1);
    await page.nodes.get("#send-form")!.emit("submit");
    expect(page.uploads).toHaveLength(1);
    await page.status({ waitingReceivers: 0, activeUpload: false, completedTransfers: 1 });
    await page.uploads[0]!.finish();
    await page.status({ waitingReceivers: 1 });
    expect(page.uploads).toHaveLength(2);
    expect(page.uploads[1]!.body).toBe(page.file);
  });

  test("100% browser upload progress does not claim that receivers have finished", async () => {
    const app = browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.uploads[0]!.upload.emit("progress", { lengthComputable: true, loaded: app.file.size, total: app.file.size });
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/waiting.*finish/i);
    expect(app.card!.querySelector(".status-text")!.textContent).not.toMatch(/transfer complete/i);
  });

  test("stopping a dedicated sender releases the file picker after its abort settles", async () => {
    const page = browser("sender.js");
    await page.status({ waitingReceivers: 1 });
    page.nodes.get("#send-file")!.files = [page.file];
    await page.nodes.get("#send-file")!.emit("change");
    await page.nodes.get("#send-form")!.emit("submit");
    await settle();
    expect(page.nodes.get("#send-file")!.disabled).toBe(true);
    await page.nodes.get("#stop-hosting")!.emit("click");
    await settle();
    expect(page.nodes.get("#send-file")!.disabled).toBe(false);
    expect(page.nodes.get("#status")!.textContent).toMatch(/hosting stopped/i);
    await page.nodes.get("#send-form")!.emit("submit");
    await settle();
    expect(page.uploads).toHaveLength(1);
    await page.sources[0]!.emit("status", { data: JSON.stringify({ waitingReceivers: 1 }) });
    await settle();
    expect(page.uploads).toHaveLength(1);
  });

  test("a submitted sender automatically recovers a cancelled receiver without another Send", async () => {
    const page = browser("sender.js");
    await page.status({ waitingReceivers: 1 });
    page.nodes.get("#send-file")!.files = [page.file];
    await page.nodes.get("#send-file")!.emit("change");
    await page.nodes.get("#send-form")!.emit("submit");
    await settle();
    expect(page.uploads).toHaveLength(1);
    await page.uploads[0]!.finish(409, JSON.stringify({ error: "Receiver left", reason: "no_receivers", retryable: true }));
    await page.advance(6000);
    expect(page.uploads).toHaveLength(2);
    expect(page.uploads[1]!.body).toBe(page.file);
  });

  test("saved links require deliberate selection of the original file before hosting resumes", async () => {
    const first = browser();
    await first.share();
    const restored = browser("app.js", first.storage);
    await restored.status({ waitingReceivers: 1 });
    expect(restored.uploads).toHaveLength(0);
    expect(restored.card!.querySelector(".status-text")!.textContent).toMatch(/select.*again/i);
    const selector = restored.card!.querySelector('[data-action="resume-file"]')!;
    selector.files = [new File(["different bytes"], "sample.txt")];
    await selector.emit("change");
    await settle();
    expect(restored.uploads).toHaveLength(0);
    selector.files = [first.file];
    await selector.emit("change");
    await settle();
    expect(restored.uploads).toHaveLength(1);
    expect(restored.uploads[0]!.body).toBe(first.file);
  });

  test("an explicit retry resumes a failed upload without an automatic retry loop", async () => {
    const app = browser();
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
      const app = browser();
      await app.share();
      await app.status({ waitingReceivers: 1 });
      await app.status({ waitingReceivers: 0, activeUpload: false });
      await app.uploads[0]!.finish(409, JSON.stringify({ error: "The receiver left", reason, retryable: true }));
      expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/still hosting/i);
      expect(app.card!.querySelector('[data-action="retry"]')!.hidden).toBe(true);
      expect(app.sources.filter((source) => !source.closed).some((source) => new URL(source.url).searchParams.get("hosting") === "1")).toBe(true);
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
    const app = browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await app.uploads[attempt]!.finish(409, JSON.stringify({ error: "Receiver timed out", reason: "receiver_stalled", retryable: true }));
      expect(app.uploads).toHaveLength(attempt + 1);
      await app.advance(100);
      expect(app.uploads).toHaveLength(attempt + 1);
      await app.advance(6000);
      expect(app.uploads).toHaveLength(attempt + 2);
    }
  });

  test("an XHR transport failure recovers only after a matching retryable terminal upload outcome", async () => {
    const app = browser();
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
    await app.status({ waitingReceivers: 1, activeUpload: false, lastUploadId: "another-attempt", lastUploadReason: "no_receivers", lastUploadRetryable: true });
    await app.advance(6000);
    expect(app.uploads).toHaveLength(1);
    expect(app.card!.querySelector(".status-text")!.textContent).toMatch(/transfer failed/i);
    await app.status({ waitingReceivers: 1, activeUpload: false, lastUploadId: uploadId, lastUploadReason: "no_receivers", lastUploadRetryable: true });
    await app.advance(6000);
    expect(app.uploads).toHaveLength(2);
    expect(app.uploads[1]!.headers["x-airshare-upload-id"]).not.toBe(uploadId);
    expect(app.uploads[1]!.body).toBe(app.file);
  });

  test("size and validation failures stay explicit even when later status mentions a recoverable receiver error", async () => {
    for (const reason of ["size_mismatch", "invalid_metadata"]) {
      const app = browser();
      await app.share();
      await app.status({ waitingReceivers: 1 });
      const uploadId = app.uploads[0]!.headers["x-airshare-upload-id"];
      await app.uploads[0]!.finish(400, JSON.stringify({ error: "Invalid file data", reason, retryable: false }));
      await app.status({ waitingReceivers: 1, activeUpload: false, lastUploadId: uploadId, lastUploadReason: "no_receivers", lastUploadRetryable: true });
      await app.advance(12000);
      expect(app.uploads).toHaveLength(1);
      expect(app.card!.querySelector(".status-text")!.textContent).toContain("Invalid file data");
      expect(app.card!.querySelector('[data-action="retry"]')!.hidden).toBe(false);
    }
  });

  test("stopping a share cancels pending automatic recovery and removes hosting presence", async () => {
    const app = browser();
    await app.share();
    await app.status({ waitingReceivers: 1 });
    await app.uploads[0]!.finish(409, JSON.stringify({ error: "Receiver left", reason: "no_receivers", retryable: true }));
    await app.card!.querySelector('[data-action="delete"]')!.emit("click");
    await app.advance(20000);
    expect(app.card).toBeUndefined();
    expect(app.uploads).toHaveLength(1);
    expect(app.sources.every((source) => source.closed)).toBe(true);
  });
});
