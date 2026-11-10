(() => {
  "use strict";
  const { ChannelConnection, formatBytes, loadChannel } = window.AirShare;
  const statusText = document.querySelector("#receiver-status");
  const download = document.querySelector("#download");
  const alertBox = document.querySelector("#receiver-alert");
  const nameText = document.querySelector("#receiver-file-name");
  const sizeText = document.querySelector("#receiver-file-size");
  // A receiver polls instead of holding a stream: on HTTP/1.1 every open stream takes one of the
  // browser's six connections to this host, which a sender tab and its downloads also need.
  const POLL_MAX_MS = 10000;
  let view = null;
  let mounts = 0;

  function setStatus(message, kind = "quiet") {
    statusText.textContent = message;
    statusText.classList.toggle("has-error", kind === "error");
    statusText.classList.toggle("is-warning", kind === "warning");
    statusText.classList.toggle("is-visible", kind === "visible");
  }

  function disableDownload() {
    download.removeAttribute("href");
    download.setAttribute("aria-disabled", "true");
  }

  function render() {
    if (!view || view.loading) return;
    const connection = view.connection;
    const current = connection?.channel;
    const filename = current?.file?.filename || "";
    nameText.textContent = filename;
    sizeText.textContent = current ? formatBytes(current.file?.contentLength) : "";
    const reason = view.closedReason || (connection?.closed ? connection.closedReason || "closed" : "");
    const unusable = Boolean(view.error || reason);
    alertBox.hidden = !filename || unusable;
    const focusLost = unusable && !download.hidden && document.activeElement === download;
    download.hidden = unusable;
    if (view.error) {
      setStatus("Could not load this share. Check your connection and reload the page.", "error");
      disableDownload();
    } else if (reason) {
      setStatus(
        reason === "sender_left" ? "The sender stopped sharing this file." : "This share is no longer available.",
        "error",
      );
      disableDownload();
    } else {
      if (current.downloadUrl) {
        download.setAttribute("href", current.downloadUrl);
        download.removeAttribute("aria-disabled");
      }
      if (connection.reconnecting) setStatus("Connection lost. Reconnecting to the sender's status.", "warning");
      else if (current.senderOnline === false) setStatus("Waiting for the sender…", "visible");
      else if (view.requested) {
        setStatus(
          view.queued && current.activeUpload
            ? "Your download is queued for the next transfer. Keep the sender tab open."
            : "Your browser manages the download. Check its downloads list for progress or completion.",
        );
      } else {
        setStatus(
          current.activeUpload
            ? "A transfer is in progress. Download now to join the next transfer."
            : "Ready to download. Keep the sender tab open until your browser finishes.",
        );
      }
    }
    // A hidden Download would drop keyboard focus to the page; the alert that replaces it takes it instead.
    if (focusLost) {
      statusText.setAttribute("tabindex", "-1");
      statusText.focus();
    }
  }

  async function mount({ key, bootstrap } = {}) {
    unmount();
    const token = mounts;
    view = { key, loading: true, connection: null, closedReason: "", error: null, requested: false, queued: false };
    // Server-rendered markup already describes the bootstrapped key; anything else must not show stale details.
    if (!bootstrap || bootstrap.key !== key || bootstrap.role !== "receiver") {
      nameText.textContent = "";
      alertBox.hidden = true;
      download.hidden = false;
      disableDownload();
      setStatus("Loading…");
    }
    const result = await loadChannel(key, "receiver", bootstrap);
    if (token !== mounts || !view) return;
    view.loading = false;
    if (result.channel) {
      view.connection = new ChannelConnection(result.channel, render, { useStream: false, pollMaxMs: POLL_MAX_MS });
      follow();
    } else if (result.closedReason) view.closedReason = result.closedReason;
    else view.error = result.error;
    render();
  }

  // Status is only followed while it can still change what this page shows: not in a hidden tab,
  // and not once the download has started.
  function follow() {
    const connection = view?.connection;
    if (!connection) return;
    if (document.hidden || view.requested) connection.disconnect(false);
    else connection.connect();
  }

  function unmount() {
    mounts += 1;
    view?.connection?.disconnect(false);
    view = null;
  }

  download?.addEventListener("click", (event) => {
    if (!view || view.loading || !download.hasAttribute("href")) {
      event.preventDefault();
      return;
    }
    view.requested = true;
    view.queued = Boolean(view.connection?.channel.activeUpload);
    follow();
    render();
  });
  document.addEventListener("visibilitychange", follow);
  window.addEventListener("pagehide", () => view?.connection?.disconnect(false));
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) follow();
  });
  window.addEventListener("online", () => {
    if (!document.hidden && !view?.requested) void view?.connection?.refresh();
  });
  // Nothing can be shared from a download page, so a dropped file is ignored here.
  window.AirShare.views.receiver = { mount, unmount, dropTarget: () => null };
})();
