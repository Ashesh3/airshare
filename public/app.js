(() => {
  "use strict";
  const {
    HostSession,
    bindFileInput,
    clearToasts,
    copyText,
    formatBytes,
    hostStatus,
    requestJSON,
    responseError,
    sameOrigin,
    toast,
  } = window.AirShare;
  // Earlier versions persisted owner and sender capabilities here; shares now live only in this page.
  try {
    localStorage.removeItem("airshare.shares.v1");
  } catch {}
  const fileInput = document.querySelector("#file-selector");
  const sharedFiles = document.querySelector("#shared-files");
  const template = document.querySelector("#file-template");
  const overlay = document.querySelector("#drop-overlay");
  const shares = new Map();
  const pending = new Set();
  let leaving = false;

  function renderEmpty() {
    if (shares.size || pending.size || document.querySelector(".empty")) return;
    const empty = document.createElement("div");
    empty.className = "empty";
    const text = document.createElement("p");
    text.textContent = "No files have been added yet";
    empty.append(text);
    sharedFiles.append(empty);
  }

  function setCount(card, count) {
    card.querySelector('[data-field="transfers"]').textContent = String(count);
    card.querySelector('[data-field="transfers-label"]').textContent = count === 1 ? "upload" : "uploads";
  }

  function rowState(share) {
    const session = share.session;
    if (share.removeError || session.error || session.connection.closed) return "error";
    if (session.connection.reconnecting || session.recoveryReason) return "notice";
    return "";
  }

  function render(share) {
    if (share.removed || leaving) return;
    const { card, session } = share;
    const channel = session.channel;
    const name = session.file?.name || channel.file?.filename || "Untitled file";
    card.querySelector(".name").textContent = name;
    card.querySelector('[data-field="url"]').textContent = channel.downloadUrl;
    card.querySelector('[data-field="size"]').textContent = formatBytes(
      session.file?.size ?? channel.file?.contentLength,
    );
    card.querySelector('[data-field="receivers"]').textContent = String(channel.waitingReceivers || 0);
    setCount(card, channel.completedTransfers || 0);
    card.querySelector(".status-text").textContent = share.removeError || hostStatus(session);
    const state = rowState(share);
    card.classList.toggle("has-error", state === "error");
    card.classList.toggle("has-status", state === "notice");
    const bar = card.querySelector(".upload-progress");
    const amount = session.uploading ? Math.max(0, Math.min(100, session.progress || 0)) : 0;
    bar.setAttribute("aria-valuenow", String(Math.floor(amount)));
    bar.setAttribute(
      "aria-valuetext",
      session.uploading ? `Upload ${Math.floor(amount)} percent` : session.completed ? "Transfer complete" : "Waiting",
    );
    card.querySelector(".upload-progress span").style.width = `${amount}%`;
    const retry = card.querySelector('[data-action="retry"]');
    retry.hidden = !session.error || session.connection.closed;
    retry.disabled = session.uploading || session.reconciling;
    if (session.connection.closed && !share.removing && !share.closedNoticeShown) {
      share.closedNoticeShown = true;
      toast(
        session.connection.closedReason === "sender_left"
          ? `${name} stopped sharing. Add it again to share it.`
          : `${name} is no longer shared. Add it again to share it.`,
        { error: true },
      );
    }
  }

  async function copyLink(share, direct = false) {
    try {
      await copyText(direct ? share.session.channel.downloadUrl : share.session.channel.humanUrl);
      toast(direct ? "Direct download link copied" : "Sharing link copied", { priority: true });
    } catch {
      toast("Could not copy the link", { error: true, priority: true });
    }
  }

  function createRow(file) {
    document.querySelector(".empty")?.remove();
    const card = template.content.firstElementChild.cloneNode(true);
    card.querySelector(".name").textContent = file.name;
    card.querySelector('[data-field="url"]').textContent = "preparing transfer...";
    for (const action of ["qr", "copy-human", "copy-direct"])
      card.querySelector(`[data-action="${action}"]`).hidden = true;
    setCount(card, 0);
    const entry = { card, file, share: null, cancelled: false };
    card.querySelector('[data-action="delete"]').addEventListener("click", () => {
      if (entry.share) {
        void removeShare(entry.share);
        return;
      }
      entry.cancelled = true;
      pending.delete(entry);
      card.remove();
      renderEmpty();
    });
    pending.add(entry);
    sharedFiles.append(card);
    return entry;
  }

  function onTransfer(share, type) {
    const name = share.session.file?.name || share.session.channel.file?.filename || "Untitled file";
    if (type === "started") toast(`Starting upload of ${name}`);
    else if (type === "succeeded") toast("A transfer succeeded");
    else if (type === "failed") toast("A transfer failed");
  }

  function activate(entry, channel) {
    const { card, file } = entry;
    card.dataset.channel = channel.id;
    for (const action of ["qr", "copy-human", "copy-direct"])
      card.querySelector(`[data-action="${action}"]`).hidden = false;
    const share = { card, removed: false, removing: false, removeError: "", closedNoticeShown: false, session: null };
    share.session = new HostSession(channel, () => render(share), { onTransfer: (type) => onTransfer(share, type) });
    entry.share = share;
    shares.set(channel.id, share);
    card.querySelector('[data-action="copy-human"]').addEventListener("click", () => copyLink(share));
    card.querySelector('[data-action="copy-direct"]').addEventListener("click", () => copyLink(share, true));
    card.querySelector('[data-action="retry"]').addEventListener("click", () => share.session.retry());
    card
      .querySelector('[data-action="qr"]')
      .addEventListener("click", (event) => showShare(share, event.currentTarget));
    share.session.setFile(file);
    render(share);
    return share;
  }

  async function addFiles(files, { dropped = false } = {}) {
    if (leaving || !files.length) return;
    const entries = files.map(createRow);
    if (dropped) toast(`${files.length} ${files.length === 1 ? "file" : "files"} added`);
    else for (const file of files) toast(`Added ${file.name}`);
    for (const entry of entries) {
      if (leaving) return;
      if (entry.cancelled) continue;
      const { file } = entry;
      try {
        const channel = await requestJSON("/api/channels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type || "application/octet-stream",
            contentLength: file.size,
            hostBound: true,
          }),
        });
        pending.delete(entry);
        if (entry.cancelled || leaving) {
          if (channel?.deleteUrl) void fetch(sameOrigin(channel.deleteUrl), { method: "DELETE" }).catch(() => {});
          continue;
        }
        activate(entry, channel);
      } catch (error) {
        pending.delete(entry);
        entry.card.remove();
        renderEmpty();
        toast(`Could not add ${file.name}: ${error.message}`, { error: true });
      }
    }
  }

  async function removeShare(share) {
    if (share.removed || share.removing) return;
    share.removing = true;
    // Stop local work before awaiting the server, so no callback can revive it.
    share.session.pause();
    const button = share.card.querySelector('[data-action="delete"]');
    button.disabled = true;
    try {
      if (!share.session.connection.closed) {
        const url = sameOrigin(
          share.session.channel.deleteUrl || `/api/channels/${encodeURIComponent(share.session.channel.id)}`,
        );
        const response = await fetch(url, { method: "DELETE" });
        if (!response.ok && response.status !== 404 && response.status !== 410) throw await responseError(response);
      }
      share.removed = true;
      share.session.dispose();
      shares.delete(share.session.channel.id);
      share.card.remove();
      renderEmpty();
    } catch (error) {
      share.removing = false;
      share.removeError = `Hosting stopped here. Could not close the link: ${error.message}. Try delete again.`;
      button.disabled = false;
      render(share);
    }
  }

  const dialog = document.querySelector("#share-dialog");
  const shareUrl = document.querySelector("#share-url");
  const shareFeedback = document.querySelector("#share-feedback");
  const shareCaption = document.querySelector("#share-caption");
  const qr = document.querySelector("#share-qr");
  let shareTrigger = null;
  let activeShareUrl = "";
  function showShare(share, trigger) {
    if (!dialog) return;
    const url = share.session.channel.humanUrl;
    const filename = share.session.file?.name || share.session.channel.file.filename;
    activeShareUrl = url;
    shareTrigger = trigger;
    if (shareUrl) shareUrl.value = url;
    qr.src = `/api/qr?url=${encodeURIComponent(url)}`;
    qr.hidden = false;
    qr.alt = `QR code for ${filename}`;
    if (shareCaption) shareCaption.textContent = "Scan the QR code to download the file";
    if (shareFeedback) shareFeedback.textContent = "";
    if (!dialog.open) dialog.showModal();
    document.querySelector("#share-close")?.focus();
  }
  qr?.addEventListener("error", () => {
    const message = "QR code unavailable. Close this view and use share URL to copy the link.";
    qr.hidden = true;
    if (shareCaption) shareCaption.textContent = message;
    if (shareFeedback) shareFeedback.textContent = message;
  });
  document.querySelector("#share-close")?.addEventListener("click", () => dialog.close());
  dialog?.addEventListener("click", (event) => {
    // The full-screen QR surface dismisses on click; compatibility copy controls
    // remain operable if they are exposed by an accessible or fallback view.
    if (!event.target.closest?.("button, input, textarea, a, select, label")) dialog.close();
  });
  dialog?.addEventListener("close", () => {
    if (shareTrigger?.isConnected !== false) shareTrigger?.focus();
  });
  document.querySelector("#share-copy")?.addEventListener("click", async () => {
    try {
      await copyText(shareUrl?.value || activeShareUrl);
      if (shareFeedback) shareFeedback.textContent = "Sharing link copied";
    } catch (error) {
      if (shareFeedback) shareFeedback.textContent = `Could not copy. ${error.message}`;
      shareUrl?.select();
    }
  });

  bindFileInput(fileInput, addFiles);

  // Each view decides what a dropped file does: the Send view puts it in its form, the receiver view
  // ignores it, and every other view shares it here, as Station307 does. Dragged text and links are
  // left alone, and file drops are always intercepted so the browser never navigates to the file.
  let dragDepth = 0;
  const overlayText = overlay?.querySelector("p");
  const shareDrop = { label: "Drop your file to share it", accept: (files) => void addFiles(files, { dropped: true }) };
  const carriesFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  const hideOverlay = () => {
    dragDepth = 0;
    overlay?.classList.remove("active");
  };
  function dropTarget() {
    const view = window.AirShare.router?.current?.();
    const choose = view && window.AirShare.views[view]?.dropTarget;
    return choose ? choose() : shareDrop;
  }
  document.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    const target = dropTarget();
    if (event.dataTransfer) event.dataTransfer.dropEffect = target ? "copy" : "none";
    if (!target) return;
    if (overlayText) overlayText.textContent = target.label;
    overlay?.classList.add("active");
  });
  document.addEventListener("dragover", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = dropTarget() ? "copy" : "none";
  });
  document.addEventListener("dragleave", (event) => {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay?.classList.remove("active");
  });
  document.addEventListener("drop", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    hideOverlay();
    const files = Array.from(event.dataTransfer?.files || []);
    const target = dropTarget();
    if (target && files.length) target.accept(files);
  });
  window.addEventListener("dragend", hideOverlay);

  function liveShares() {
    return Array.from(shares.values()).filter(
      (share) => !share.removed && share.session.file && !share.session.connection.closed,
    );
  }
  window.addEventListener("beforeunload", (event) => {
    if (!liveShares().length) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("pagehide", (event) => {
    leaving = true;
    clearToasts();
    for (const share of shares.values()) {
      const open = !share.removed && !share.session.connection.closed;
      share.session.suspend();
      // A page that is really unloading can never host these files again, so end their links now.
      if (!event.persisted && open && share.session.channel.deleteUrl) {
        const url = new URL(sameOrigin(share.session.channel.deleteUrl));
        url.searchParams.set("reason", "sender_left");
        try {
          void fetch(url.href, { method: "DELETE", keepalive: true }).catch(() => {});
        } catch {}
      }
    }
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    leaving = false;
    for (const share of shares.values()) share.session.resume();
  });
  window.addEventListener("online", () => {
    for (const share of shares.values()) void share.session.connection.refresh();
  });
  window.AirShare.views.home = { liveCount: () => liveShares().length };
})();
