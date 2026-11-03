(() => {
  "use strict";
  const { ChannelConnection, formatBytes } = window.AirShare;
  const channel = window.AIRSHARE_CHANNEL || window.STATION_CHANNEL;
  const statusText = document.querySelector("#status");
  const download = document.querySelector("#download");
  let requested = false;
  let queued = false;
  // Downloads keep an HTTP connection open; status polling avoids using a second
  // permanent connection per receiver tab on HTTP/1 servers.
  const connection = new ChannelConnection(channel, render, { useEvents: false });

  function render() {
    const current = connection.channel;
    statusText.classList.toggle("has-error", Boolean(connection.closed || connection.reconnecting));
    const name = document.querySelector("#file-name");
    const size = document.querySelector("#file-size");
    if (name) name.textContent = current.file?.filename || "Shared file";
    if (size) size.textContent = formatBytes(current.file?.contentLength);
    if (current.downloadUrl) download.href = current.downloadUrl;
    if (connection.closed) {
      statusText.textContent = "This share is no longer available. Ask the sender for a new link.";
      download.removeAttribute("href");
      download.setAttribute("aria-disabled", "true");
    } else if (connection.reconnecting) {
      statusText.textContent = "Connection lost. Reconnecting to the sender's status.";
    } else if (requested) {
      statusText.textContent = queued && current.activeUpload
        ? "Your download is queued for the next transfer. Keep the sender tab open."
        : "Your browser manages the download. Check its downloads list for progress or completion.";
    } else {
      statusText.textContent = current.activeUpload
        ? "A transfer is in progress. Download now to join the next transfer."
        : current.senderOnline === false
          ? "File available. The sender must open their share before your download can begin."
          : "Ready to download. Keep the sender tab open until your browser finishes.";
    }
  }

  download?.addEventListener("click", (event) => {
    if (connection.closed) { event.preventDefault(); return; }
    requested = true;
    queued = Boolean(connection.channel.activeUpload);
    render();
  });
  connection.connect();
  render();
  window.addEventListener("pagehide", () => connection.disconnect());
  window.addEventListener("pageshow", (event) => { if (event.persisted) connection.connect(); });
  window.addEventListener("online", () => { void connection.refresh(); });
})();
