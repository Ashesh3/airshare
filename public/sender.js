(() => {
  "use strict";
  const { HostSession, formatBytes, hostStatus, loadChannel, toast } = window.AirShare;
  const input = document.querySelector("#send-file");
  const form = document.querySelector("#send-form");
  const send = document.querySelector("#send-button");
  const statusText = document.querySelector("#send-status");
  const stop = document.querySelector("#stop-hosting");
  const retry = document.querySelector("#retry-transfer");
  const progress = document.querySelector("#send-progress");
  const progressBar = document.querySelector("#transfer-progress");
  const note = document.querySelector("#send-note");
  // Sessions belong to the page, not the view, so hosting continues while other views are shown.
  const sessions = new Map();
  let current = null;
  let mounts = 0;

  function unavailableText(state) {
    if (state.error) return "Could not load this request. Check your connection and reload the page.";
    const reason = state.closedReason || state.host?.connection.closedReason;
    return reason === "sender_left" ? "The sender stopped sharing this file." : "This share is no longer available.";
  }

  function render() {
    const state = current;
    if (!state) return;
    const host = state.host;
    const name = document.querySelector("#send-file-name");
    const size = document.querySelector("#send-file-size");
    if (!host || host.connection.closed) {
      statusText.textContent = state.loading ? "Loading…" : unavailableText(state);
      statusText.classList.toggle("has-error", !state.loading);
      input.disabled = true;
      if (send) send.disabled = true;
      if (stop) stop.hidden = true;
      if (retry) retry.hidden = true;
      if (progress) progress.hidden = true;
      if (note) note.hidden = true;
      if (name) name.textContent = host?.channel.file?.filename || "Send a file";
      return;
    }
    statusText.textContent =
      state.selectionError ||
      (host.connection.reconnecting
        ? "Connection lost. Reconnecting; keep this tab open."
        : host.file || host.paused || host.error
          ? hostStatus(host)
          : "Choose a file and press Send. Keep this tab open for later receivers.");
    statusText.classList.toggle(
      "has-error",
      Boolean(state.selectionError || host.error || host.connection.reconnecting),
    );
    input.disabled = host.uploading;
    if (send) send.disabled = !state.selectedFile || host.uploading || host.reconciling;
    if (stop) {
      stop.hidden = !host.file;
      stop.disabled = host.paused;
    }
    if (retry) {
      retry.hidden = !host.error;
      retry.disabled = host.uploading || host.reconciling;
    }
    const hosting = Boolean(host.file) && !host.paused;
    if (progress) progress.hidden = !hosting;
    if (progressBar) {
      const amount = host.uploading ? Math.max(0, Math.min(100, host.progress || 0)) : 0;
      progressBar.style.width = `${amount}%`;
      progressBar.setAttribute("aria-valuenow", String(Math.floor(amount)));
      progressBar.setAttribute(
        "aria-valuetext",
        host.uploading ? `Upload ${Math.floor(amount)} percent` : "Waiting for a receiver",
      );
    }
    if (note) note.hidden = !hosting || Boolean(host.error);
    if (name)
      name.textContent = host.file?.name || state.selectedFile?.name || host.channel.file?.filename || "Send a file";
    if (size)
      size.textContent = formatBytes(host.file?.size ?? state.selectedFile?.size ?? host.channel.file?.contentLength);
  }

  async function mount({ key, bootstrap } = {}) {
    const token = ++mounts;
    let state = sessions.get(key);
    if (state !== current) {
      // A File cannot be put back into an input, so a remounted request starts with an empty picker.
      input.value = "";
      if (state && !state.host?.file) state.selectedFile = null;
    }
    if (state) {
      current = state;
      render();
      return;
    }
    state = { key, host: null, loading: true, closedReason: "", error: null, selectedFile: null, selectionError: "" };
    sessions.set(key, state);
    current = state;
    render();
    const result = await loadChannel(key, "sender", bootstrap);
    state.loading = false;
    if (result.channel) {
      state.host = new HostSession(
        result.channel,
        () => {
          if (current === state) render();
        },
        {
          onTransfer: (type) => {
            if (type === "succeeded") toast("Upload completed");
            else if (type === "failed") toast("A transfer failed");
          },
        },
      );
      state.host.connect();
    } else if (result.closedReason) state.closedReason = result.closedReason;
    else {
      state.error = result.error;
      sessions.delete(key);
    }
    if (token === mounts && current === state) render();
  }

  function unmount() {
    mounts += 1;
    current = null;
  }

  function choose(file) {
    if (!current?.host) return;
    current.selectedFile = file || null;
    current.selectionError = "";
    render();
  }
  input.addEventListener("change", () => choose(input.files?.[0]));

  // A file dropped on this view fills the form, exactly as if it had been chosen in "File to send".
  function dropTarget() {
    if (!current?.host || current.host.connection.closed || input.disabled) return null;
    return {
      label: "Drop your file to send it",
      accept: (files) => {
        try {
          const transfer = new DataTransfer();
          transfer.items.add(files[0]);
          input.files = transfer.files;
        } catch {}
        choose(files[0]);
      },
    };
  }
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const state = current;
    const host = state?.host;
    if (!host || host.uploading || host.reconciling || host.connection.closed) return;
    if (!state.selectedFile) {
      state.selectionError = "Choose a file before pressing Send.";
      render();
      input.focus();
      return;
    }
    state.selectionError = "";
    host.setFile(state.selectedFile);
  });
  stop?.addEventListener("click", () => {
    const state = current;
    if (!state?.host) return;
    state.selectedFile = null;
    state.selectionError = "";
    input.value = "";
    state.host.pause();
  });
  retry?.addEventListener("click", () => current?.host?.retry());

  function liveCount() {
    return Array.from(sessions.values()).filter(
      (state) => state.host?.file && !state.host.paused && !state.host.connection.closed,
    ).length;
  }
  window.addEventListener("beforeunload", (event) => {
    if (!liveCount()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("pagehide", () => {
    for (const state of sessions.values()) state.host?.suspend();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) for (const state of sessions.values()) state.host?.resume();
  });
  window.addEventListener("online", () => {
    for (const state of sessions.values()) void state.host?.connection.refresh();
  });
  window.AirShare.views.send = { mount, unmount, liveCount, dropTarget };
})();
