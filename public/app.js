(() => {
  "use strict";
  const { HostSession, bindFileInput, copyText, formatBytes, hostStatus, requestJSON, responseError } = window.AirShare;
  const fileInput = document.querySelector("#file-selector");
  const sharedFiles = document.querySelector("#shared-files");
  const template = document.querySelector("#file-template");
  const notice = document.querySelector("#notice");
  const shares = new Map();
  const STORAGE_KEY = "airshare.shares.v1";
  let leaving = false;
  let noticeTimer = null;

  function announce(message, error = false) {
    if (!notice) return;
    clearTimeout(noticeTimer);
    noticeTimer = null;
    notice.textContent = message;
    notice.hidden = !message;
    notice.classList.toggle("is-error", error);
    if (!error && message) noticeTimer = setTimeout(() => {
      notice.textContent = "";
      notice.hidden = true;
      noticeTimer = null;
    }, 4000);
  }

  function saveShares() {
    const saved = Array.from(shares.values()).filter((share) => !share.removed).map((share) => ({
      channel: share.session.channel,
      originalFile: share.originalFile,
    }));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch {
      announce("Shares are active, but this browser cannot remember their links after a reload.");
    }
  }

  function renderEmpty() {
    if (shares.size) return;
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No files have been added yet";
    sharedFiles.append(empty);
  }

  function render(share) {
    if (share.removed || leaving) return;
    const { card, session } = share;
    const channel = session.channel;
    const file = session.file;
    card.querySelector(".name").textContent = file?.name || channel.file?.filename || "Untitled file";
    const link = card.querySelector('[data-field="url"]');
    link.textContent = channel.downloadUrl;
    link.href = channel.downloadUrl;
    card.querySelector('[data-field="size"]').textContent = formatBytes(file?.size ?? channel.file?.contentLength);
    card.querySelector('[data-field="receivers"]').textContent = String(channel.waitingReceivers || 0);
    card.querySelector('[data-field="transfers"]').textContent = String(channel.completedTransfers || 0);
    card.querySelector(".status-text").textContent = share.removeError || hostStatus(session);
    card.classList.toggle("has-error", Boolean(session.error || share.removeError || session.connection.closed || session.connection.reconnecting));
    const bar = card.querySelector(".upload-progress");
    const amount = Math.max(0, Math.min(100, session.progress || 0));
    bar.setAttribute("aria-valuenow", String(Math.floor(amount)));
    bar.setAttribute("aria-valuetext", session.uploading ? `Upload ${Math.floor(amount)} percent` : session.completed ? "Transfer complete" : "Waiting");
    card.querySelector(".upload-progress span").style.width = `${amount}%`;
    const retry = card.querySelector('[data-action="retry"]');
    retry.hidden = !session.error || session.connection.closed;
    retry.disabled = session.uploading || session.reconciling;
    const resume = card.querySelector('[data-action="resume"]');
    resume.hidden = Boolean(session.file) || session.connection.closed;
    card.querySelector('[data-action="delete"]').textContent = "delete";
  }

  async function copyLink(share, direct = false) {
    try {
      await copyText(direct ? share.session.channel.downloadUrl : share.session.channel.humanUrl);
      announce(direct ? "Direct download link copied." : "Share link copied.");
    } catch (error) { announce(`Could not copy. ${error.message}`, true); }
  }

  function addShare(channel, file = null, originalFile = null) {
    document.querySelector(".empty")?.remove();
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.channel = channel.id;
    const share = { card, removed: false, removeError: "", originalFile, session: null };
    share.session = new HostSession(channel, () => render(share));
    if (file) share.originalFile = { name: file.name, size: file.size, lastModified: file.lastModified };
    shares.set(channel.id, share);
    sharedFiles.append(card);
    card.querySelector('[data-action="copy-human"]').addEventListener("click", () => copyLink(share));
    card.querySelector('[data-action="copy-direct"]').addEventListener("click", () => copyLink(share, true));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => removeShare(share));
    card.querySelector('[data-action="retry"]').addEventListener("click", () => share.session.retry());
    card.querySelector('[data-action="qr"]').addEventListener("click", (event) => showShare(share, event.currentTarget));
    const resumeInput = card.querySelector('[data-action="resume-file"]');
    card.querySelector('[data-action="resume"]').addEventListener("click", () => resumeInput.click());
    resumeInput.addEventListener("change", () => {
      const selected = resumeInput.files?.[0];
      resumeInput.value = "";
      if (!selected) return;
      const expected = share.originalFile || { name: channel.file.filename, size: channel.file.contentLength };
      if (selected.name !== expected.name || (expected.size !== undefined && selected.size !== expected.size)
        || (expected.lastModified !== undefined && selected.lastModified !== expected.lastModified)) {
        announce("Choose the original file to resume this link. Add a changed file as a new share.", true);
        return;
      }
      share.session.setFile(selected);
      saveShares();
    });
    if (file) share.session.setFile(file); else share.session.connect();
    render(share);
    return share;
  }

  async function addFiles(files) {
    const failures = [];
    for (const file of files) {
      if (leaving) break;
      announce(`Preparing ${file.name}…`);
      try {
        const channel = await requestJSON("/api/channels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentType: file.type || "application/octet-stream", contentLength: file.size }),
        });
        if (leaving) return;
        addShare(channel, file);
        saveShares();
        announce(`${file.name} is ready to share.`);
      } catch (error) {
        failures.push(`${file.name}: ${error.message}`);
        announce(`Could not share ${file.name}: ${error.message}`, true);
      }
    }
    if (failures.length) announce(`Could not share ${failures.join("; ")}`, true);
  }

  async function removeShare(share) {
    if (share.removed) return;
    // Stop local work before awaiting the server, so no callback can revive it.
    share.session.pause();
    const button = share.card.querySelector('[data-action="delete"]');
    button.disabled = true;
    try {
      if (!share.session.connection.closed) {
        const url = share.session.channel.deleteUrl || `/api/channels/${encodeURIComponent(share.session.channel.id)}`;
        const response = await fetch(url, { method: "DELETE" });
        if (!response.ok && response.status !== 404 && response.status !== 410) throw await responseError(response);
      }
      share.removed = true;
      share.session.dispose();
      shares.delete(share.session.channel.id);
      share.card.remove();
      saveShares();
      renderEmpty();
      announce("Sharing stopped and the link removed.");
    } catch (error) {
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
    try { await copyText(shareUrl?.value || activeShareUrl); if (shareFeedback) shareFeedback.textContent = "Share link copied."; }
    catch (error) { if (shareFeedback) shareFeedback.textContent = `Could not copy. ${error.message}`; shareUrl?.select(); }
  });

  bindFileInput(fileInput, document.querySelector("#drop-zone"), addFiles);
  for (const code of document.querySelectorAll("[data-recipe]")) {
    code.textContent = code.dataset.recipe.replaceAll("{{origin}}", location.origin);
  }

  function restoreShares() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return; }
    if (!Array.isArray(saved)) return;
    for (const item of saved.slice(0, 50)) {
      const channel = item?.channel;
      if (!channel || typeof channel.id !== "string" || typeof channel.eventsUrl !== "string") continue;
      const urls = [channel.eventsUrl, channel.statusUrl, channel.uploadUrl, channel.humanUrl, channel.downloadUrl, channel.deleteUrl].filter(Boolean);
      try {
        if (urls.some((url) => new URL(url, location.href).origin !== location.origin)) continue;
        if (!channel.uploadUrl || !channel.humanUrl || !channel.file) continue;
        if (!leaving && !shares.has(channel.id)) addShare(channel, null, item.originalFile);
      } catch {}
    }
  }
  restoreShares();

  window.addEventListener("beforeunload", (event) => {
    if (Array.from(shares.values()).some((share) => share.session.uploading)) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("pagehide", () => {
    leaving = true;
    clearTimeout(noticeTimer);
    noticeTimer = null;
    if (notice) { notice.textContent = ""; notice.hidden = true; }
    for (const share of shares.values()) share.session.suspend();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    leaving = false;
    for (const share of shares.values()) share.session.resume();
  });
  window.addEventListener("online", () => { for (const share of shares.values()) void share.session.connection.refresh(); });
})();
