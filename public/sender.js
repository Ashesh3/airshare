(() => {
  "use strict";
  const { HostSession, formatBytes, hostStatus } = window.AirShare;
  const channel = window.AIRSHARE_CHANNEL || window.STATION_CHANNEL;
  const input = document.querySelector("#send-file");
  const form = document.querySelector("#send-form");
  const send = document.querySelector("#send-button");
  const statusText = document.querySelector("#status");
  const stop = document.querySelector("#stop-hosting");
  const retry = document.querySelector("#retry-transfer");
  const progress = document.querySelector("#transfer-progress");
  const share = document.querySelector("#share-link");
  let selectedFile = null;
  let selectionError = "";
  const host = new HostSession(channel, render);

  function render() {
    statusText.textContent = selectionError || (host.connection.reconnecting
      ? "Connection lost. Reconnecting; keep this tab open."
      : host.file || host.paused || host.error || host.connection.closed
        ? hostStatus(host) : "Choose a file and press Send. Keep this tab open for later receivers.");
    statusText.classList.toggle("has-error", Boolean(selectionError || host.error || host.connection.closed || host.connection.reconnecting));
    input.disabled = host.uploading || host.connection.closed;
    if (send) send.disabled = !selectedFile || host.uploading || host.reconciling || host.connection.closed;
    if (stop) { stop.hidden = !host.file; stop.disabled = host.paused; }
    if (retry) { retry.hidden = !host.error || host.connection.closed; retry.disabled = host.uploading || host.reconciling; }
    if (progress) {
      progress.hidden = !host.uploading && !host.completed;
      if (host.progress === null) progress.removeAttribute("value"); else progress.value = host.progress;
      progress.setAttribute("aria-label", host.progress >= 100 ? "Upload sent; waiting for transfer completion" : "Upload progress");
    }
    if (share) { share.href = host.channel.humanUrl; share.textContent = "Open receiver link"; }
    const name = document.querySelector("#file-name");
    const size = document.querySelector("#file-size");
    if (name) name.textContent = host.file?.name || selectedFile?.name || host.channel.file?.filename || "Send a file";
    if (size) size.textContent = formatBytes(host.file?.size ?? selectedFile?.size ?? host.channel.file?.contentLength);
  }

  input.addEventListener("change", () => {
    selectedFile = input.files?.[0] || null;
    selectionError = "";
    render();
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (host.uploading || host.reconciling || host.connection.closed) return;
    if (!selectedFile) {
      selectionError = "Choose a file before pressing Send.";
      render();
      input.focus();
      return;
    }
    selectionError = "";
    host.setFile(selectedFile);
  });
  stop?.addEventListener("click", () => {
    selectedFile = null;
    selectionError = "";
    input.value = "";
    host.pause();
  });
  retry?.addEventListener("click", () => host.retry());
  host.connect();
  render();
  window.addEventListener("beforeunload", (event) => {
    if (host.uploading) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("pagehide", () => host.suspend());
  window.addEventListener("pageshow", (event) => { if (event.persisted) host.resume(); });
  window.addEventListener("online", () => { void host.connection.refresh(); });
})();
