(() => {
  "use strict";

  const TRACKER_PATH = "/api/v1/track?format=native";
  // Pings arrive every 5 s; a stream silent for longer than this is treated as dead.
  const STREAM_DEAD_MS = 15000;
  // Without an open stream a hosting page renews its presence leases (10 s) in under half of that.
  // While the stream is open it never renews them, so a crashed tab ends after the grace period alone.
  const PRESENCE_POLL_MS = 4000;
  const MAX_PRESENCE_KEYS = 256;
  const MAX_INTERRUPTED_RETRIES = 3;
  const IDLE_POLL_MIN_MS = 2000;
  const IDLE_POLL_MAX_MS = 15000;
  let activeStatusRequests = 0;
  const statusQueue = [];

  // Hosting renewals jump the queue so many idle shares on a slow link cannot starve them.
  function scheduleStatusRequest(task, urgent = false) {
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject };
      if (urgent) statusQueue.unshift(entry);
      else statusQueue.push(entry);
      drainStatusQueue();
    });
  }

  function drainStatusQueue() {
    while (activeStatusRequests < 2 && statusQueue.length) {
      const { task, resolve, reject } = statusQueue.shift();
      activeStatusRequests += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeStatusRequests -= 1;
          drainStatusQueue();
        });
    }
  }

  // Payload URLs use PUBLIC_URL; page requests go to the page's own origin so they never need a preflight.
  function sameOrigin(url) {
    try {
      const parsed = new URL(url, location.href);
      return `${location.origin}${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  }

  async function responseError(response) {
    let message = await response.text();
    try {
      message = JSON.parse(message).error || message;
    } catch {}
    return new Error(String(message || `Request failed (HTTP ${response.status})`).slice(0, 300));
  }

  async function closedReasonOf(response) {
    if (response.status === 404) return "not_found";
    try {
      return (await response.json())?.reason || "closed";
    } catch {
      return "closed";
    }
  }

  function readBootstrap() {
    const element = document.querySelector("#airshare-channel");
    if (!element) return null;
    try {
      return JSON.parse(element.textContent || "null");
    } catch {
      return null;
    }
  }

  // Resolves a page key to its channel, using the server-rendered bootstrap when it is for the same key.
  async function loadChannel(key, role, bootstrap) {
    if (bootstrap && bootstrap.key === key && bootstrap.role === role) {
      return bootstrap.channel
        ? { channel: bootstrap.channel }
        : { closedReason: bootstrap.closedReason || "not_found" };
    }
    try {
      const response = await fetch(`/api/channels/${encodeURIComponent(key)}`, { cache: "no-store" });
      if (response.status === 404 || response.status === 410) return { closedReason: await closedReasonOf(response) };
      if (!response.ok) throw await responseError(response);
      const channel = await response.json();
      return channel?.role === role ? { channel } : { closedReason: "not_found" };
    } catch (error) {
      return { error };
    }
  }

  async function requestJSON(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", ...options });
    if (!response.ok) throw await responseError(response);
    return response.json();
  }

  function parse(data) {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  // One status stream per page carries every channel the page follows.
  class PageStream {
    constructor() {
      this.connections = new Map();
      this.source = null;
      this.trackerKey = null;
      this.lastEvent = 0;
      this.failures = 0;
      this.retryTimer = null;
      this.watchdog = null;
      this.queues = new Map();
    }

    get live() {
      return Boolean(this.trackerKey);
    }
    get connecting() {
      return Boolean(this.source) && !this.trackerKey;
    }

    add(connection) {
      this.connections.set(connection.key, connection);
      this.open();
      if (this.trackerKey) this.subscribe(connection);
    }

    remove(connection, unsubscribe) {
      if (this.connections.get(connection.key) !== connection) return;
      this.connections.delete(connection.key);
      const tracker = this.trackerKey;
      if (unsubscribe && tracker) {
        this.enqueue(connection.key, () =>
          fetch(this.subscribeUrl(connection, tracker), { method: "DELETE" }).catch(() => {}),
        );
      }
      if (!this.connections.size) this.close();
    }

    update(connection) {
      if (this.trackerKey && this.connections.get(connection.key) === connection) this.subscribe(connection);
    }

    open() {
      if (this.source || this.retryTimer || !this.connections.size) return;
      let source;
      try {
        source = new EventSource(TRACKER_PATH);
      } catch {
        this.failed();
        return;
      }
      this.source = source;
      this.lastEvent = Date.now();
      source.addEventListener("tracker_event", (event) => {
        if (source !== this.source) return;
        this.lastEvent = Date.now();
        const key = parse(event.data)?.initialized?.tracker_key;
        if (!key) return;
        this.trackerKey = key;
        this.failures = 0;
        for (const connection of this.connections.values()) this.subscribe(connection);
      });
      source.addEventListener("status", (event) => {
        if (source !== this.source) return;
        this.lastEvent = Date.now();
        const status = parse(event.data);
        if (status) this.connections.get(status.id)?.accept(status);
      });
      source.addEventListener("closed", (event) => {
        if (source !== this.source) return;
        this.lastEvent = Date.now();
        const data = parse(event.data);
        // markClosed removes the connection, which closes the stream once nothing else needs it.
        if (data) this.connections.get(data.id)?.markClosed(data.reason || "closed");
      });
      source.addEventListener("error", () => {
        if (source !== this.source) return;
        this.trackerKey = null;
        // A non-200 reconnect (proxy restart, 429) leaves the EventSource permanently closed.
        if (source.readyState === 2) this.failed();
        for (const connection of this.connections.values()) connection.streamLost();
      });
      this.watchdog = setInterval(() => {
        if (source !== this.source || Date.now() - this.lastEvent <= STREAM_DEAD_MS) return;
        this.failed();
        for (const connection of this.connections.values()) connection.streamLost();
      }, 5000);
    }

    failed() {
      this.dropSource();
      this.failures += 1;
      if (this.retryTimer || !this.connections.size) return;
      const delay = Math.min(1000 * 2 ** (this.failures - 1), 30000);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.open();
      }, delay);
    }

    dropSource() {
      this.source?.close();
      this.source = null;
      this.trackerKey = null;
      clearInterval(this.watchdog);
      this.watchdog = null;
    }

    close() {
      this.dropSource();
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.failures = 0;
    }

    subscribeUrl(connection, tracker, hosting) {
      const url = new URL(
        sameOrigin(connection.channel.statusUrl || `/api/channels/${encodeURIComponent(connection.key)}`),
      );
      url.pathname = `${url.pathname.replace(/\/$/, "")}/subscribe/${encodeURIComponent(tracker)}`;
      url.search = hosting === undefined ? "" : `?hosting=${hosting ? 1 : 0}`;
      return url.href;
    }

    subscribe(connection) {
      const tracker = this.trackerKey;
      const current = () => tracker === this.trackerKey && this.connections.get(connection.key) === connection;
      this.enqueue(connection.key, async () => {
        if (!current()) return;
        const version = connection.version;
        const hosting = connection.isHosting();
        let response;
        try {
          response = await fetch(this.subscribeUrl(connection, tracker, hosting), {
            method: "POST",
            cache: "no-store",
          });
        } catch {
          if (current()) this.retryLater(connection);
          return;
        }
        if (!current()) return;
        if (response.ok) {
          const status = parse(await response.text());
          if (!current()) return;
          connection.subscribed(tracker, hosting);
          // A streamed event that arrived meanwhile is newer than this response's snapshot.
          if (connection.version === version) connection.accept(status);
          return;
        }
        const body = parse(await response.text().catch(() => ""));
        // The stream reconnected underneath this request; the next initialized event resubscribes.
        if (response.status === 404 && body?.reason === "tracker_not_found") return;
        if (response.status === 404 || response.status === 410) {
          connection.markClosed(response.status === 404 ? "not_found" : body?.reason || "closed");
          return;
        }
        // Limits and server errors are temporary: presence or polling covers the key until a retry succeeds.
        this.retryLater(connection);
      });
    }

    retryLater(connection) {
      const delay = connection.subscribeFailed();
      if (delay) setTimeout(() => this.update(connection), delay);
    }

    enqueue(key, task) {
      const next = (this.queues.get(key) || Promise.resolve()).then(task).catch(() => {});
      this.queues.set(key, next);
      void next.finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    }
  }

  let sharedStream = null;
  function pageStream() {
    return (sharedStream ??= new PageStream());
  }

  // Hosting keys the page stream is not carrying renew their leases together in one request.
  class PresenceLeases {
    constructor() {
      this.connections = new Set();
      this.timer = null;
      this.inFlight = false;
      this.pending = false;
      this.batchLimit = MAX_PRESENCE_KEYS;
    }

    sync(connection, urgent = false) {
      if (!connection.needsLease) {
        this.drop(connection, false);
        return;
      }
      const added = !this.connections.has(connection);
      this.connections.add(connection);
      if (added || urgent) this.schedule(urgent ? 0 : PRESENCE_POLL_MS);
    }

    drop(connection, release) {
      if (!this.connections.delete(connection)) return;
      if (!this.connections.size) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (release) {
        void fetch(sameOrigin("/api/presence"), {
          method: "POST",
          cache: "no-store",
          keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keys: [connection.key], hosting: false }),
        }).catch(() => {});
      }
    }

    schedule(delay) {
      if (this.inFlight) {
        if (delay === 0) this.pending = true;
        return;
      }
      if (this.timer && delay > 0) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.renew();
      }, delay);
    }

    async renew() {
      const connections = [...this.connections];
      if (!connections.length) return;
      this.inFlight = true;
      const chunk = (list) =>
        Array.from({ length: Math.ceil(list.length / this.batchLimit) }, (_, index) =>
          list.slice(index * this.batchLimit, (index + 1) * this.batchLimit),
        );
      try {
        const batches = chunk(connections);
        while (batches.length) {
          const batch = batches.shift();
          const versions = batch.map((connection) => connection.version);
          let result = null;
          let limit = 0;
          try {
            const response = await fetch(sameOrigin("/api/presence"), {
              method: "POST",
              cache: "no-store",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ keys: batch.map((connection) => connection.key), hosting: true }),
            });
            if (response.ok) result = await response.json();
            else if (response.status === 400 && batch.length > 1) {
              const body = parse(await response.text());
              if (body?.reason === "too_many_keys")
                limit = Number(body.max) > 0 ? Number(body.max) : Math.ceil(batch.length / 2);
            }
          } catch {}
          // A server with a smaller presence limit rejects the whole batch; resend it in pieces it accepts.
          if (limit) {
            this.batchLimit = Math.max(1, Math.min(limit, batch.length - 1));
            batches.unshift(...chunk(batch));
            continue;
          }
          batch.forEach((connection, position) => {
            if (!this.connections.has(connection)) return;
            const key = connection.key;
            if (!result || typeof result !== "object") connection.leaseFailed();
            else if (result.closed?.[key]) connection.markClosed(result.closed[key].reason || "closed");
            else if (Array.isArray(result.unknown) && result.unknown.includes(key)) connection.markClosed("not_found");
            // A streamed event that arrived meanwhile is newer than this response's snapshot.
            else if (connection.version === versions[position]) connection.accept(result.channels?.[key]);
          });
        }
      } finally {
        this.inFlight = false;
        const again = this.pending;
        this.pending = false;
        if (this.connections.size) this.schedule(again ? 0 : PRESENCE_POLL_MS);
      }
    }
  }

  let sharedPresence = null;
  function presenceLeases() {
    return (sharedPresence ??= new PresenceLeases());
  }

  class ChannelConnection {
    constructor(
      channel,
      onChange,
      { useStream = true, isHosting = () => false, stream = null, presence = null, pollMaxMs = IDLE_POLL_MAX_MS } = {},
    ) {
      this.channel = { ...channel };
      this.key = channel.id;
      this.onChange = onChange;
      this.connected = false;
      this.reconnecting = false;
      this.closed = false;
      this.closedReason = "";
      this.suspended = true;
      this.version = 0;
      this.timer = null;
      this.refreshing = null;
      this.generation = 0;
      this.useStream = useStream;
      this.isHosting = isHosting;
      this.stream = stream || pageStream();
      this.presence = presence || presenceLeases();
      this.pollMaxMs = pollMaxMs;
      this.idleDelay = IDLE_POLL_MIN_MS;
      this.subscribedTracker = null;
      this.subscribedHosting = false;
      this.subscribeFailures = 0;
      // Counts recoveries from a lost status connection, so a host can tell the relay came back.
      this.reconnections = 0;
    }

    get streaming() {
      return this.useStream;
    }
    // The stream carries a key only once its subscribe under the current tracker has succeeded.
    get carried() {
      return this.streaming && this.stream.live && this.subscribedTracker === this.stream.trackerKey;
    }
    get needsLease() {
      return !this.closed && !this.suspended && this.isHosting() && !(this.carried && this.subscribedHosting);
    }

    connect() {
      if (this.closed || !this.suspended) return;
      this.suspended = false;
      this.generation += 1;
      this.idleDelay = IDLE_POLL_MIN_MS;
      if (this.streaming) this.stream.add(this);
      else if (!this.isHosting()) void this.refresh();
      // An open or opening stream usually carries the key within moments; otherwise renew now.
      this.presence.sync(this, !(this.streaming && (this.stream.connecting || this.stream.live)));
      this.schedulePoll();
    }

    // Polling covers a non-hosting channel the page stream is not carrying; hosting ones get their
    // status from the batched presence renewals.
    schedulePoll() {
      if (this.timer || this.closed || this.suspended || this.carried || this.isHosting()) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.closed || this.suspended || this.carried || this.isHosting()) return;
        this.idleDelay = Math.min(this.idleDelay * 1.5, this.pollMaxMs);
        void this.refresh().finally(() => this.schedulePoll());
      }, this.idleDelay);
    }

    subscribed(tracker, hosting) {
      this.subscribedTracker = tracker;
      this.subscribedHosting = hosting;
      this.subscribeFailures = 0;
      clearTimeout(this.timer);
      this.timer = null;
      this.presence.sync(this);
    }

    // Returns how long to wait before subscribing again, or 0 when the connection is gone.
    subscribeFailed() {
      if (this.suspended || this.closed) return 0;
      this.subscribedTracker = null;
      this.subscribeFailures += 1;
      if (!this.isHosting()) void this.refresh();
      this.presence.sync(this, true);
      this.schedulePoll();
      return Math.min(1000 * 2 ** (this.subscribeFailures - 1), 30000);
    }

    streamLost() {
      if (this.suspended || this.closed) return;
      this.subscribedTracker = null;
      this.connected = false;
      this.reconnecting = true;
      this.onChange();
      this.presence.sync(this, true);
      this.schedulePoll();
    }

    leaseFailed() {
      if (this.suspended || this.closed) return;
      this.connected = false;
      this.reconnecting = true;
      this.onChange();
    }

    updateHosting() {
      if (this.suspended || this.closed) return;
      const open = this.streaming && this.stream.live;
      if (open) this.stream.update(this);
      this.presence.sync(this, !open);
      if (!this.carried && !this.isHosting()) this.schedulePoll();
    }

    accept(status) {
      if (!status || typeof status !== "object" || this.closed || this.suspended) return;
      this.version += 1;
      Object.assign(this.channel, status);
      if (this.reconnecting) this.reconnections += 1;
      this.connected = true;
      this.reconnecting = false;
      this.onChange();
    }

    async refresh() {
      if (this.closed || this.suspended) return false;
      if (this.refreshing) return this.refreshing;
      const url = this.channel.statusUrl;
      if (!url) return false;
      const version = this.version;
      const generation = this.generation;
      const controller = new AbortController();
      this.refreshController = controller;
      this.refreshing = scheduleStatusRequest(async () => {
        let timeout;
        try {
          if (this.suspended || generation !== this.generation) return false;
          timeout = setTimeout(
            () => controller.abort(new DOMException("Status request timed out", "TimeoutError")),
            10000,
          );
          const response = await fetch(sameOrigin(url), { cache: "no-store", signal: controller.signal });
          if (this.suspended || generation !== this.generation) return false;
          if (response.status === 404 || response.status === 410) {
            this.markClosed(await closedReasonOf(response));
            return false;
          }
          if (!response.ok) throw await responseError(response);
          const status = await response.json();
          if (generation !== this.generation || this.suspended) return false;
          // A newer streamed update takes precedence over an earlier HTTP snapshot.
          if (this.version === version) this.accept(status);
          return true;
        } catch (error) {
          if (this.suspended || generation !== this.generation || error.name === "AbortError") return false;
          this.connected = false;
          this.reconnecting = true;
          this.onChange();
          return false;
        } finally {
          clearTimeout(timeout);
          if (this.refreshController === controller) {
            this.refreshController = null;
            this.refreshing = null;
          }
        }
      }, this.isHosting());
      return this.refreshing;
    }

    // Leaving without unsubscribing is for page unloads, where the stream itself is closing.
    disconnect(unsubscribe = true) {
      this.suspended = true;
      this.generation += 1;
      this.connected = false;
      this.stream.remove(this, unsubscribe && this.streaming);
      this.subscribedTracker = null;
      this.subscribedHosting = false;
      this.subscribeFailures = 0;
      this.presence.drop(this, unsubscribe);
      clearTimeout(this.timer);
      this.timer = null;
      this.refreshController?.abort();
      this.refreshController = null;
      this.refreshing = null;
    }

    markClosed(reason = "closed") {
      if (this.closed) return;
      this.closed = true;
      this.closedReason = reason;
      this.disconnect(false);
      this.onChange();
    }
  }

  function uploadAttemptId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function receiverDeparture(reason) {
    return reason === "no_receivers" || reason === "receiver_stalled";
  }

  function uploadFile(url, file, signal, onProgress, attemptId) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const uploadUrl = new URL(sameOrigin(url));
      // The last segment is the file name on both /u/<key>/<name> and /api/channels/<key>/upload/<name> links.
      uploadUrl.pathname = uploadUrl.pathname.replace(/\/[^/]*$/, `/${encodeURIComponent(file.name)}`);
      const abort = () => xhr.abort();
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      xhr.open("POST", uploadUrl.href, true);
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.setRequestHeader("x-airshare-no-redirect", "1");
      xhr.setRequestHeader("x-airshare-file-size", String(file.size));
      xhr.setRequestHeader("x-airshare-upload-id", attemptId);
      xhr.upload.addEventListener("progress", (event) => {
        if (!settled)
          onProgress(
            event.lengthComputable && event.total > 0 ? Math.min(100, (event.loaded / event.total) * 100) : null,
          );
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) finish();
        else {
          let details;
          try {
            details = JSON.parse(xhr.responseText);
          } catch {}
          const error = new Error(
            String(details?.error || xhr.responseText || `Upload failed (HTTP ${xhr.status})`).slice(0, 300),
          );
          error.reason = details?.reason;
          error.retryable = details?.retryable === true && (xhr.status === 409 || xhr.status === 408);
          if (xhr.status === 429) {
            const seconds = Number(xhr.getResponseHeader?.("retry-after"));
            error.retryAfterMs = Math.min(Math.max(Number.isFinite(seconds) ? seconds * 1000 : 1000, 1000), 30000);
          }
          finish(error);
        }
      });
      xhr.addEventListener("error", () => {
        const error = new Error("The connection was interrupted. Check your connection and retry.");
        error.transportFailure = true;
        finish(error);
      });
      xhr.addEventListener("abort", () => finish(new DOMException("Upload cancelled", "AbortError")));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        finish(new DOMException("Upload cancelled", "AbortError"));
        return;
      }
      // The browser streams the File without creating a full-file JS copy.
      xhr.send(file);
    });
  }

  // A host's hosting state. Page lifecycle (suspended) and object lifecycle (disposed) are tracked apart.
  //   idle         no file yet
  //   waiting      hosting a file until a receiver is waiting
  //   uploading    an upload attempt is in flight
  //   reconciling  refreshing status after an upload, a recovery delay or Retry
  //   recovering   a receiver left; waiting out a short delay before hosting again
  //   failed       the last upload failed; waiting for Retry or another file
  //   paused       hosting was stopped and the file released
  //   closed       the share is closed or deleted; nothing leaves this state
  const HOST_TRANSITIONS = Object.freeze({
    idle: Object.freeze(["waiting", "reconciling", "paused", "closed"]),
    waiting: Object.freeze(["uploading", "reconciling", "recovering", "paused", "closed"]),
    uploading: Object.freeze(["waiting", "failed", "paused", "closed"]),
    reconciling: Object.freeze(["waiting", "idle", "paused", "closed"]),
    recovering: Object.freeze(["reconciling", "waiting", "paused", "closed"]),
    failed: Object.freeze(["waiting", "reconciling", "recovering", "paused", "closed"]),
    paused: Object.freeze(["waiting", "closed"]),
    closed: Object.freeze([]),
  });

  class HostSession {
    static TRANSITIONS = HOST_TRANSITIONS;

    constructor(channel, onChange, { onTransfer = () => {} } = {}) {
      this.onChange = onChange;
      this.onTransfer = onTransfer;
      this.state = "idle";
      this.file = null;
      this.progress = 0;
      this.error = "";
      this.completed = false;
      this.disposed = false;
      this.suspended = false;
      this.controller = null;
      this.uploadAttempt = 0;
      this.recoveryTimer = null;
      this.recoveryGeneration = 0;
      this.recoveryAttempts = 0;
      this.recoveryReason = "";
      this.pendingOutcome = null;
      this.interruptedAt = null;
      this.interruptedRetries = 0;
      this.limited = false;
      this.connection = new ChannelConnection(
        channel,
        () => {
          if (this.disposed) return;
          if (this.connection.closed) {
            this.clearRecovery();
            this.controller?.abort();
            this.to("closed");
          } else this.recoverTerminalOutcome();
          this.emit();
          void this.maybeUpload();
        },
        { isHosting: () => this.hosting },
      );
    }

    get channel() {
      return this.connection.channel;
    }
    get uploading() {
      return this.state === "uploading";
    }
    get reconciling() {
      return this.state === "reconciling";
    }
    get paused() {
      return this.state === "paused";
    }
    get hosting() {
      return Boolean(this.file) && !this.paused && !this.suspended && !this.disposed;
    }
    connect() {
      if (!this.disposed) this.connection.connect();
    }

    to(next) {
      if (next === this.state) return;
      if (!HOST_TRANSITIONS[this.state].includes(next))
        throw new Error(`A host cannot go from ${this.state} to ${next}`);
      this.state = next;
    }

    setFile(file) {
      if (this.state === "closed" || this.state === "uploading") return false;
      this.file = file;
      this.error = "";
      this.clearRecovery();
      this.to("waiting");
      this.recoveryAttempts = 0;
      this.interruptedRetries = 0;
      this.completed = false;
      this.progress = 0;
      if (this.connection.suspended) this.connect();
      else this.connection.updateHosting();
      this.emit();
      void this.maybeUpload();
      return true;
    }

    emit() {
      if (!this.disposed) this.onChange(this);
    }

    transfer(type) {
      try {
        this.onTransfer(type, this);
      } catch {}
    }

    async maybeUpload() {
      if (
        this.state !== "waiting" ||
        this.suspended ||
        !this.file ||
        !this.connection.connected ||
        this.channel.activeUpload ||
        !(this.channel.waitingReceivers > 0)
      )
        return;
      this.to("uploading");
      const attempt = ++this.uploadAttempt;
      this.completed = false;
      this.recoveryReason = "";
      this.pendingOutcome = null;
      this.progress = 0;
      const controller = new AbortController();
      this.controller = controller;
      const attemptId = uploadAttemptId();
      this.emit();
      // A retry after the relay's upload limit is the same transfer, so it is announced only once.
      if (!this.limited) this.transfer("started");
      let succeeded = false;
      let recoveryReason = "";
      let failed = false;
      let busy = false;
      let limitedFor = 0;
      try {
        await uploadFile(
          this.channel.uploadUrl,
          this.file,
          controller.signal,
          (progress) => {
            if (this.state !== "uploading" || this.suspended || this.controller !== controller) return;
            this.progress = progress;
            this.emit();
          },
          attemptId,
        );
        succeeded = true;
        this.completed = true;
        this.progress = 0;
        this.recoveryAttempts = 0;
        this.interruptedRetries = 0;
        this.limited = false;
      } catch (error) {
        // Pausing, leaving, deleting or closing cancels the attempt without counting as a failure.
        const current = this.state === "uploading" && !this.suspended;
        if (current && error.reason === "busy") busy = true;
        else if (current && error.reason === "upload_limit") limitedFor = error.retryAfterMs || 1000;
        else if (current) {
          failed = true;
          if (error.retryable && receiverDeparture(error.reason)) recoveryReason = error.reason;
          else {
            this.error =
              error.name === "AbortError" ? "The upload was cancelled. Retry when you are ready." : error.message;
            if (error.transportFailure) {
              // An early socket close can hide a receiver-departure JSON reply.
              // Only this attempt's matching terminal outcome can reclassify it.
              this.pendingOutcome = attemptId;
              this.interruptedAt = this.connection.reconnections;
              await this.connection.refresh();
              if (this.canRecover(attemptId)) recoveryReason = this.channel.lastUploadReason;
            }
          }
        }
      } finally {
        // Stopping, adding the file again and Retry can start a newer attempt while this one still awaits
        // its status refresh; that attempt owns the controller, the state and the outcome from then on.
        if (attempt !== this.uploadAttempt) return;
        this.controller = null;
        if (this.state === "uploading") this.to(this.error ? "failed" : "waiting");
        if (!limitedFor) this.limited = false;
        if (this.disposed || this.suspended) return;
        this.progress = 0;
        if (busy) {
          // Another upload holds the channel; the status that shows it idle again starts this one.
          this.channel.activeUpload = true;
          this.emit();
          void this.connection.refresh();
          return;
        }
        if (limitedFor) {
          // This browser has too many uploads open at the relay; try again when it says, without a failure.
          this.limited = true;
          this.queueRecovery("", limitedFor);
          return;
        }
        if (succeeded) this.transfer("succeeded");
        else if (failed) this.transfer("failed");
        if (this.paused) {
          this.emit();
          return;
        }
        if (recoveryReason) {
          this.queueRecovery(recoveryReason);
          return;
        }
        // Until a status reflects this upload's completion, the known receiver counts may be stale.
        // Reconcile so a receiver joining a running transfer gets the next one, and nobody gets two.
        const reconcile = succeeded && this.channel.lastUploadId !== attemptId;
        if (reconcile && this.state === "waiting") this.to("reconciling");
        this.emit();
        if (reconcile) await this.connection.refresh();
        if (this.state === "reconciling") this.to("waiting");
        this.emit();
        if (succeeded) void this.maybeUpload();
        // The relay may already be back, so an interrupted upload need not wait for another status.
        else this.recoverTerminalOutcome();
      }
    }

    canRecover(attemptId) {
      return (
        attemptId &&
        !this.connection.closed &&
        !this.channel.activeUpload &&
        this.channel.lastUploadId === attemptId &&
        this.channel.lastUploadRetryable === true &&
        receiverDeparture(this.channel.lastUploadReason)
      );
    }

    // After a dropped upload connection, a relay that comes back (a restart, for example) still has
    // waiting receivers; a few automatic attempts keep a sender who walked away serving them.
    canRetryInterrupted() {
      return (
        this.interruptedAt !== null &&
        this.interruptedRetries < MAX_INTERRUPTED_RETRIES &&
        this.connection.reconnections > this.interruptedAt &&
        this.connection.connected &&
        !this.connection.closed &&
        !this.channel.activeUpload &&
        this.channel.waitingReceivers > 0
      );
    }

    recoverTerminalOutcome() {
      if (this.state !== "failed" || this.suspended || !this.pendingOutcome) return;
      if (this.canRecover(this.pendingOutcome)) this.queueRecovery(this.channel.lastUploadReason);
      else if (this.canRetryInterrupted()) {
        this.interruptedRetries += 1;
        this.queueRecovery("interrupted");
      }
    }

    clearRecovery() {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      this.recoveryGeneration += 1;
      this.recoveryReason = "";
      this.pendingOutcome = null;
    }

    // An explicit delay (the relay's Retry-After) leaves the departure backoff untouched.
    queueRecovery(reason, delay = null) {
      this.clearRecovery();
      this.error = "";
      this.completed = false;
      this.progress = 0;
      this.recoveryReason = reason;
      this.to("recovering");
      const generation = this.recoveryGeneration;
      if (delay === null) {
        delay = Math.min(500 * 2 ** this.recoveryAttempts, 5000);
        this.recoveryAttempts = Math.min(this.recoveryAttempts + 1, 4);
      }
      this.recoveryTimer = setTimeout(async () => {
        this.recoveryTimer = null;
        if (this.state !== "recovering" || this.suspended || generation !== this.recoveryGeneration) return;
        this.to("reconciling");
        await this.connection.refresh();
        if (generation !== this.recoveryGeneration) return;
        if (this.state === "reconciling") this.to("waiting");
        this.emit();
        void this.maybeUpload();
        // With nobody left to send to, the next upload is a new transfer and is announced again.
        if (!this.uploading) this.limited = false;
      }, delay);
      this.emit();
    }

    async retry() {
      if (this.state === "closed" || this.state === "uploading") return;
      this.clearRecovery();
      this.recoveryAttempts = 0;
      this.interruptedRetries = 0;
      this.error = "";
      this.connect();
      // A stopped host stays stopped; Retry only clears its error.
      if (!this.paused) this.to("reconciling");
      this.emit();
      await this.connection.refresh();
      if (this.state === "reconciling") this.to(this.file ? "waiting" : "idle");
      this.emit();
      void this.maybeUpload();
    }

    pause() {
      if (this.state !== "closed") this.to("paused");
      this.file = null;
      this.clearRecovery();
      this.controller?.abort();
      this.connection.disconnect();
      this.emit();
    }

    suspend() {
      this.suspended = true;
      this.clearRecovery();
      if (this.state === "uploading")
        this.error = "The upload was interrupted when this page was left. Retry the transfer.";
      else if (this.state === "reconciling") this.to(this.file ? "waiting" : "idle");
      else if (this.state === "recovering") this.to("waiting");
      this.controller?.abort();
      this.connection.disconnect(false);
    }

    resume() {
      if (this.disposed) return;
      this.suspended = false;
      if (!this.paused) this.connect();
      this.emit();
    }

    dispose() {
      this.disposed = true;
      this.file = null;
      this.clearRecovery();
      this.to("closed");
      this.controller?.abort();
      this.connection.disconnect();
    }
  }

  function hostStatus(host) {
    if (host.connection.closed)
      return host.connection.closedReason === "sender_left"
        ? "Sharing stopped. Add the file again to share it."
        : "This share is no longer available. Add the file again to create a new link.";
    if (host.paused) return "Hosting stopped. Choose a file to start hosting again.";
    if (host.error) return `Transfer failed: ${host.error}`;
    if (host.connection.reconnecting) return "Connection lost. Reconnecting…";
    if (host.uploading) {
      if (host.progress >= 100) return "Upload sent. Waiting for receivers to finish.";
      const progress = host.progress === null ? "" : ` ${Math.floor(host.progress)}%`;
      return `Uploading${progress} to the relay.`;
    }
    if (host.recoveryReason === "interrupted")
      return "The connection to the relay was interrupted. Still hosting for the next receiver.";
    if (host.recoveryReason)
      return host.recoveryReason === "receiver_stalled"
        ? "The receiver stopped responding. Still hosting for the next receiver."
        : "The receiver disconnected. Still hosting for the next receiver.";
    if (host.reconciling) return "Transfer finished. Checking for waiting receivers.";
    if (host.channel.activeUpload)
      return "Another sender is transferring. Waiting for the channel to become available.";
    if (host.completed) return "Transfer complete. Still hosting for the next receiver.";
    return "Ready to share. Keep this tab open while receivers download.";
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {}
    }
    const previous = document.activeElement;
    const area = document.createElement("textarea");
    area.value = text;
    area.readOnly = true;
    area.setAttribute("aria-label", "Link to copy");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.append(area);
    try {
      area.focus();
      area.select();
      area.setSelectionRange(0, text.length);
      if (!document.execCommand("copy")) throw new Error("Select and copy the visible link instead.");
    } finally {
      area.remove();
      previous?.focus?.();
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  // Station307-style toasts: shown one at a time, in order, each for about 1.5 s.
  const TOAST_MS = 1500;
  const TOAST_ERROR_MS = 4000;
  const TOAST_FADE_MS = 300;
  const TOAST_LIMIT = 5;
  const toastQueue = [];
  let toastTimer = null;
  let toastShowing = false;
  let toastShown = null;
  let toastCount = 0;

  // Toasts the user asked for (copies) go ahead of transfer news. The queue keeps the newest five,
  // and a message identical to the queued or still visible toast it would follow is not repeated;
  // one that is already fading out no longer counts, so a quick repeat is shown again.
  function toast(message, { error = false, priority = false } = {}) {
    if (!message) return;
    let position = toastQueue.length;
    if (priority) {
      position = 0;
      while (position < toastQueue.length && toastQueue[position].priority) position += 1;
    }
    const previous = position ? toastQueue[position - 1] : toastShowing ? toastShown : null;
    if (previous && previous.message === message && previous.error === error) return;
    toastQueue.splice(position, 0, { message, error, priority, order: (toastCount += 1) });
    while (toastQueue.length > TOAST_LIMIT) {
      const oldest = toastQueue.reduce((first, entry) => (entry.order < first.order ? entry : first));
      toastQueue.splice(toastQueue.indexOf(oldest), 1);
    }
    if (!toastShowing) showNextToast();
  }

  function showNextToast() {
    const region = document.querySelector("#notice");
    const next = toastQueue.shift();
    if (!region || !next) {
      toastShowing = false;
      toastShown = null;
      return;
    }
    toastShowing = true;
    toastShown = next;
    const text = region.querySelector(".message") || region;
    text.textContent = next.message;
    region.classList.toggle("is-error", next.error);
    region.classList.add("active");
    toastTimer = setTimeout(
      () => {
        region.classList.remove("active");
        toastShown = null;
        toastTimer = setTimeout(() => {
          toastTimer = null;
          if (toastQueue.length) showNextToast();
          else {
            text.textContent = "";
            toastShowing = false;
            toastShown = null;
          }
        }, TOAST_FADE_MS);
      },
      next.error ? TOAST_ERROR_MS : TOAST_MS,
    );
  }

  function clearToasts() {
    toastQueue.length = 0;
    clearTimeout(toastTimer);
    toastTimer = null;
    toastShowing = false;
    toastShown = null;
    const region = document.querySelector("#notice");
    if (!region) return;
    region.classList.remove("active");
    (region.querySelector(".message") || region).textContent = "";
  }

  function bindFileInput(input, onFiles) {
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      input.value = "";
      if (files.length) void onFiles(files);
    });
  }

  window.AirShare = {
    ChannelConnection,
    HostSession,
    bindFileInput,
    clearToasts,
    copyText,
    formatBytes,
    hostStatus,
    loadChannel,
    pageStream,
    readBootstrap,
    requestJSON,
    responseError,
    sameOrigin,
    toast,
    views: {},
  };
})();
