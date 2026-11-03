(() => {
  "use strict";

  // Keep HTTP/1 connections available for transfers when many files are shared.
  let eventConnections = 0;
  const MAX_EVENT_CONNECTIONS = 3;
  let activeStatusRequests = 0;
  const statusQueue = [];

  function scheduleStatusRequest(task) {
    return new Promise((resolve, reject) => {
      statusQueue.push({ task, resolve, reject });
      drainStatusQueue();
    });
  }

  function drainStatusQueue() {
    while (activeStatusRequests < 2 && statusQueue.length) {
      const { task, resolve, reject } = statusQueue.shift();
      activeStatusRequests += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        activeStatusRequests -= 1;
        drainStatusQueue();
      });
    }
  }

  async function responseError(response) {
    let message = await response.text();
    try { message = JSON.parse(message).error || message; } catch {}
    return new Error(String(message || `Request failed (HTTP ${response.status})`).slice(0, 300));
  }

  async function requestJSON(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", ...options });
    if (!response.ok) throw await responseError(response);
    return response.json();
  }

  class ChannelConnection {
    constructor(channel, onChange, { useEvents = true, isHosting = () => false } = {}) {
      this.channel = { ...channel };
      this.onChange = onChange;
      this.connected = false;
      this.reconnecting = false;
      this.closed = false;
      this.suspended = true;
      this.version = 0;
      this.source = null;
      this.timer = null;
      this.refreshing = null;
      this.generation = 0;
      this.useEvents = useEvents;
      this.isHosting = isHosting;
    }

    connect() {
      if (this.closed || !this.suspended) return;
      this.suspended = false;
      const generation = ++this.generation;
      if (this.useEvents && eventConnections < MAX_EVENT_CONNECTIONS && this.channel.eventsUrl) {
        const eventsUrl = new URL(this.channel.eventsUrl, location.href);
        eventsUrl.searchParams.delete("hosting");
        if (this.isHosting()) eventsUrl.searchParams.set("hosting", "1");
        const source = new EventSource(eventsUrl.href);
        this.source = source;
        eventConnections += 1;
        source.addEventListener("status", (event) => {
          if (this.suspended || this.closed || generation !== this.generation) return;
          try { this.accept(JSON.parse(event.data)); } catch {
            this.connected = false;
            this.reconnecting = true;
            this.onChange();
            this.scheduleRefresh();
          }
        });
        source.addEventListener("open", () => {
          if (this.suspended || generation !== this.generation) return;
          this.reconnecting = false;
          this.onChange();
        });
        source.addEventListener("error", () => {
          if (this.suspended || this.closed || generation !== this.generation) return;
          this.connected = false;
          this.reconnecting = true;
          this.onChange();
          clearTimeout(this.timer);
          this.timer = null;
          this.scheduleRefresh();
        });
        source.addEventListener("closed", () => {
          if (generation === this.generation) this.markClosed();
        });
      } else {
        void this.refresh();
      }
      this.scheduleRefresh();
    }

    accept(status) {
      if (!status || typeof status !== "object" || this.closed || this.suspended) return;
      this.version += 1;
      Object.assign(this.channel, status);
      if (status.closed) { this.markClosed(); return; }
      this.connected = true;
      this.reconnecting = false;
      this.onChange();
    }

    scheduleRefresh() {
      if (this.timer || this.closed || this.suspended) return;
      const delay = !this.source || this.reconnecting ? 2000 : 15000;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.refresh().finally(() => this.scheduleRefresh());
      }, delay);
    }

    async refresh() {
      if (this.closed || this.suspended) return false;
      if (this.refreshing) return this.refreshing;
      const url = this.channel.statusUrl || this.channel.eventsUrl?.replace(/\/events(?:\?.*)?$/, "");
      if (!url) return false;
      const version = this.version;
      const generation = this.generation;
      const controller = new AbortController();
      this.refreshController = controller;
      this.refreshing = scheduleStatusRequest(async () => {
        let timeout;
        try {
          if (this.suspended || generation !== this.generation) return false;
          timeout = setTimeout(() => controller.abort(new DOMException("Status request timed out", "TimeoutError")), 10000);
          const headers = this.isHosting() ? { "x-airshare-sender-presence": "1" } : {};
          const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers });
          if (this.suspended || generation !== this.generation) return false;
          if (response.status === 404 || response.status === 410) {
            this.markClosed();
            return false;
          }
          if (!response.ok) throw await responseError(response);
          const status = await response.json();
          if (generation !== this.generation || this.suspended) return false;
          // A newer SSE update takes precedence over an earlier HTTP snapshot.
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
      });
      return this.refreshing;
    }

    disconnect() {
      this.suspended = true;
      this.generation += 1;
      this.connected = false;
      if (this.source) {
        this.source.close();
        this.source = null;
        eventConnections -= 1;
      }
      clearTimeout(this.timer);
      this.timer = null;
      this.refreshController?.abort();
      this.refreshController = null;
      this.refreshing = null;
    }

    markClosed() {
      if (this.closed) return;
      this.closed = true;
      this.disconnect();
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
      const uploadUrl = new URL(url, location.href);
      uploadUrl.pathname = uploadUrl.pathname.replace(/\/upload(?:\/.*)?$/, `/upload/${encodeURIComponent(file.name)}`);
      const abort = () => xhr.abort();
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      xhr.open("POST", uploadUrl.href, true);
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.setRequestHeader("x-airshare-no-redirect", "1");
      xhr.setRequestHeader("x-airshare-file-size", String(file.size));
      xhr.setRequestHeader("x-airshare-upload-id", attemptId);
      xhr.upload.addEventListener("progress", (event) => {
        if (!settled) onProgress(event.lengthComputable && event.total > 0
          ? Math.min(100, (event.loaded / event.total) * 100) : null);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) finish();
        else {
          let details;
          try { details = JSON.parse(xhr.responseText); } catch {}
          const error = new Error(String(details?.error || xhr.responseText || `Upload failed (HTTP ${xhr.status})`).slice(0, 300));
          error.reason = details?.reason;
          error.retryable = details?.retryable === true && (xhr.status === 409 || xhr.status === 408);
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
      if (signal.aborted) { finish(new DOMException("Upload cancelled", "AbortError")); return; }
      // The browser streams the File without creating a full-file JS copy.
      xhr.send(file);
    });
  }

  class HostSession {
    constructor(channel, onChange) {
      this.onChange = onChange;
      this.file = null;
      this.uploading = false;
      this.reconciling = false;
      this.progress = 0;
      this.currentReceivers = 0;
      this.error = "";
      this.completed = false;
      this.paused = false;
      this.disposed = false;
      this.suspended = false;
      this.controller = null;
      this.recoveryTimer = null;
      this.recoveryGeneration = 0;
      this.recoveryAttempts = 0;
      this.recovering = false;
      this.recoveryReason = "";
      this.pendingOutcome = null;
      this.connection = new ChannelConnection(channel, () => {
        if (this.disposed) return;
        if (this.connection.closed) {
          this.clearRecovery();
          this.controller?.abort();
        } else this.recoverTerminalOutcome();
        this.emit();
        void this.maybeUpload();
      }, { isHosting: () => Boolean(this.file) && !this.paused && !this.suspended && !this.disposed });
    }

    get channel() { return this.connection.channel; }
    connect() { if (!this.disposed) this.connection.connect(); }

    setFile(file) {
      if (this.disposed || this.uploading || this.connection.closed) return false;
      this.file = file;
      this.paused = false;
      this.error = "";
      this.clearRecovery();
      this.recoveryAttempts = 0;
      this.completed = false;
      this.progress = 0;
      this.connection.disconnect();
      this.connect();
      this.emit();
      void this.connection.refresh();
      void this.maybeUpload();
      return true;
    }

    emit() { if (!this.disposed) this.onChange(this); }

    async maybeUpload() {
      if (this.disposed || this.suspended || this.paused || this.uploading || this.reconciling || this.recovering || this.error || !this.file
        || this.connection.closed || !this.connection.connected || this.channel.activeUpload
        || !(this.channel.waitingReceivers > 0)) return;
      this.uploading = true;
      this.completed = false;
      this.recoveryReason = "";
      this.pendingOutcome = null;
      this.progress = 0;
      this.currentReceivers = this.channel.waitingReceivers;
      const controller = new AbortController();
      this.controller = controller;
      const attemptId = uploadAttemptId();
      this.emit();
      let succeeded = false;
      let recoveryReason = "";
      try {
        await uploadFile(this.channel.uploadUrl, this.file, controller.signal, (progress) => {
          if (this.disposed || this.paused || this.suspended || this.controller !== controller) return;
          this.progress = progress;
          this.emit();
        }, attemptId);
        succeeded = true;
        this.completed = true;
        this.progress = 100;
        this.recoveryAttempts = 0;
      } catch (error) {
        if (!this.disposed && !this.paused && !this.suspended && !this.connection.closed) {
          if (error.retryable && receiverDeparture(error.reason)) recoveryReason = error.reason;
          else {
            this.error = error.name === "AbortError" ? "The upload was cancelled. Retry when you are ready." : error.message;
            if (error.transportFailure) {
              // An early socket close can hide a receiver-departure JSON reply.
              // Only this attempt's matching terminal outcome can reclassify it.
              this.pendingOutcome = attemptId;
              await this.connection.refresh();
              if (this.canRecover(attemptId)) recoveryReason = this.channel.lastUploadReason;
            }
          }
        }
      } finally {
        this.uploading = false;
        this.controller = null;
        this.currentReceivers = 0;
        if (this.disposed || this.suspended) return;
        if (this.paused) { this.emit(); return; }
        if (recoveryReason) { this.queueRecovery(recoveryReason); return; }
        // Final SSE can precede XHR completion. Reconcile after the upload settles
        // so a receiver joining a running transfer always gets the next one.
        this.reconciling = succeeded;
        this.emit();
        if (succeeded) await this.connection.refresh();
        this.reconciling = false;
        this.emit();
        if (succeeded) void this.maybeUpload();
      }
    }

    canRecover(attemptId) {
      return attemptId && !this.connection.closed && !this.channel.activeUpload
        && this.channel.lastUploadId === attemptId && this.channel.lastUploadRetryable === true
        && receiverDeparture(this.channel.lastUploadReason);
    }

    recoverTerminalOutcome() {
      if (this.uploading || this.disposed || this.paused || this.suspended || !this.error || !this.pendingOutcome) return;
      if (this.canRecover(this.pendingOutcome)) this.queueRecovery(this.channel.lastUploadReason);
    }

    clearRecovery() {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      this.recoveryGeneration += 1;
      this.recovering = false;
      this.reconciling = false;
      this.recoveryReason = "";
      this.pendingOutcome = null;
    }

    queueRecovery(reason) {
      this.clearRecovery();
      this.error = "";
      this.completed = false;
      this.progress = 0;
      this.recoveryReason = reason;
      this.recovering = true;
      const generation = this.recoveryGeneration;
      const delay = Math.min(500 * 2 ** this.recoveryAttempts, 5000);
      this.recoveryAttempts = Math.min(this.recoveryAttempts + 1, 4);
      this.recoveryTimer = setTimeout(async () => {
        this.recoveryTimer = null;
        if (this.disposed || this.paused || this.suspended || generation !== this.recoveryGeneration) return;
        this.reconciling = true;
        await this.connection.refresh();
        if (generation !== this.recoveryGeneration) return;
        this.reconciling = false;
        this.recovering = false;
        this.emit();
        void this.maybeUpload();
      }, delay);
      this.emit();
    }

    async retry() {
      if (this.disposed || this.uploading || this.connection.closed) return;
      this.clearRecovery();
      this.recoveryAttempts = 0;
      this.error = "";
      this.connect();
      this.reconciling = true;
      this.emit();
      await this.connection.refresh();
      this.reconciling = false;
      this.emit();
      void this.maybeUpload();
    }

    pause() {
      this.paused = true;
      this.file = null;
      this.clearRecovery();
      this.controller?.abort();
      this.connection.disconnect();
      this.emit();
    }

    suspend() {
      this.suspended = true;
      this.clearRecovery();
      if (this.uploading) this.error = "The upload was interrupted when this page was left. Retry the transfer.";
      this.controller?.abort();
      this.connection.disconnect();
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
      this.controller?.abort();
      this.connection.disconnect();
    }
  }

  function hostStatus(host) {
    if (host.connection.closed) return "This share is no longer available. Add the file again to create a new link.";
    if (host.paused) return "Hosting stopped. Choose a file to start hosting again.";
    if (host.error) return `Transfer failed: ${host.error}`;
    if (!host.file) return "Select this file again to resume hosting. File access is not restored after a reload.";
    if (host.connection.reconnecting) return "Connection lost. Reconnecting; keep this tab open.";
    if (host.uploading) {
      if (host.progress >= 100) return "Upload sent. Waiting for receivers to finish.";
      const progress = host.progress === null ? "" : ` ${Math.floor(host.progress)}%`;
      return `Uploading${progress} to the relay.`;
    }
    if (host.recoveryReason) return host.recoveryReason === "receiver_stalled"
      ? "The receiver stopped responding. Still hosting for the next receiver."
      : "The receiver disconnected. Still hosting for the next receiver.";
    if (host.reconciling) return "Transfer finished. Checking for waiting receivers.";
    if (host.channel.activeUpload) return "Another sender is transferring. Waiting for the channel to become available.";
    if (host.completed) return "Transfer complete. Still hosting for the next receiver.";
    return "Ready to share. Keep this tab open while receivers download.";
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return; } catch {}
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
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  function bindFileInput(input, zone, onFiles) {
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      input.value = "";
      if (files.length) void onFiles(files);
    });
    if (!zone) return;
    let depth = 0;
    zone.addEventListener("dragenter", (event) => { event.preventDefault(); depth += 1; zone.classList.add("is-dragging"); });
    zone.addEventListener("dragover", (event) => { event.preventDefault(); });
    zone.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove("is-dragging"); });
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      depth = 0;
      zone.classList.remove("is-dragging");
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length) void onFiles(files);
    });
  }

  window.AirShare = { ChannelConnection, HostSession, bindFileInput, copyText, formatBytes, hostStatus, requestJSON, responseError };
})();
