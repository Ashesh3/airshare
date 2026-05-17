const fileInput = document.querySelector("#file-selector");
const dropZone = document.querySelector("#drop-zone");
const sharedFiles = document.querySelector("#shared-files");
const template = document.querySelector("#file-template");

const channels = new Map();

fileInput.addEventListener("change", () => {
  addFiles(Array.from(fileInput.files ?? []));
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  addFiles(Array.from(event.dataTransfer.files ?? []));
});

async function addFiles(fileList) {
  for (const file of fileList) {
    try {
      const channel = await createChannel(file);
      channel.fileObject = file;
      channel.expectedSize = file.size;
      channel.uploading = false;
      channel.abortController = null;
      channel.eventSource = new EventSource(channel.eventsUrl);
      channel.eventSource.addEventListener("status", (event) => {
        Object.assign(channel, JSON.parse(event.data));
        renderChannel(channel);
        maybeUpload(channel);
      });
      channels.set(channel.id, channel);
      renderChannel(channel);
    } catch (error) {
      alert(`Could not share ${file.name}: ${error.message}`);
    }
  }
}

async function createChannel(file) {
  const response = await fetch("/api/channels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      contentLength: file.size,
    }),
  });

  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function renderChannel(channel) {
  document.querySelector(".empty")?.remove();

  let card = sharedFiles.querySelector(`[data-channel="${channel.id}"]`);
  if (!card) {
    card = template.content.firstElementChild.cloneNode(true);
    card.dataset.channel = channel.id;
    card.querySelector(".name").textContent = channel.file.filename;
    card.querySelector('[data-field="url"]').textContent = channel.humanUrl;
    card.querySelector('[data-action="open"]').href = channel.humanUrl;
    card.querySelector('[data-action="copy-human"]').addEventListener("click", () => copy(channel.humanUrl));
    card.querySelector('[data-action="copy-direct"]').addEventListener("click", () => copy(channel.downloadUrl));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => removeChannel(channel));
    sharedFiles.append(card);
  }

  const receivers = channel.waitingReceivers ?? 0;
  const transfers = channel.completedTransfers ?? 0;
  const status = card.querySelector(".status-text");
  const progress = card.querySelector(".upload-progress span");

  card.querySelector('[data-field="receivers"]').textContent = String(receivers);
  card.querySelector('[data-field="transfers"]').textContent = String(transfers);
  card.querySelector('[data-field="size"]').textContent = formatBytes(channel.file?.contentLength ?? channel.expectedSize ?? 0);

  if (channel.uploading) {
    status.textContent = `Streaming ${formatPercent(channel.progress)} to ${channel.currentReceivers || receivers || 1} receiver${(channel.currentReceivers || receivers || 1) === 1 ? "" : "s"}.`;
    progress.style.width = `${Math.max(channel.progress || 3, 3)}%`;
    return;
  }

  progress.style.width = "0%";
  if (receivers > 0) {
    status.textContent = `${receivers} receiver${receivers === 1 ? "" : "s"} waiting. Starting upload.`;
  } else {
    status.textContent = "Share URL is ready. Keep this tab open while receivers download.";
  }
}

async function maybeUpload(channel) {
  if (channel.uploading || !channel.fileObject || (channel.waitingReceivers ?? 0) === 0) return;
  channel.uploading = true;
  channel.progress = 0;
  channel.currentReceivers = channel.waitingReceivers;
  channel.abortController = new AbortController();
  renderChannel(channel);

  try {
    await uploadFile(channel);
  } catch (error) {
    if (error.name !== "AbortError") {
      const card = sharedFiles.querySelector(`[data-channel="${channel.id}"]`);
      if (card) card.querySelector(".status-text").textContent = `Transfer failed: ${error.message}`;
    }
  } finally {
    channel.uploading = false;
    channel.progress = 0;
    channel.currentReceivers = 0;
    channel.abortController = null;
    renderChannel(channel);
  }
}

async function uploadFile(channel) {
  const file = channel.fileObject;
  await uploadWithProgress(channel, file, (progress) => {
    channel.progress = progress;
    renderChannel(channel);
  });

  channel.progress = 100;
  renderChannel(channel);
}

function uploadWithProgress(channel, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();

    xhr.open("POST", channel.uploadUrl, true);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-airshare-no-redirect", "1");
    xhr.setRequestHeader("x-airshare-file-size", String(file.size));

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total === 0) {
        onProgress(5);
        return;
      }
      onProgress(Math.max(1, Math.round((event.loaded / event.total) * 100)));
    });

    xhr.addEventListener("load", () => {
      channel.abortController.signal.removeEventListener("abort", abort);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(xhr.responseText || `Upload failed with HTTP ${xhr.status}`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("abort", () => reject(new DOMException("Upload aborted", "AbortError")));

    channel.abortController.signal.addEventListener("abort", abort, { once: true });
    onProgress(1);
    xhr.send(file);
  });
}

async function removeChannel(channel) {
  channel.abortController?.abort();
  channel.eventSource?.close();
  channels.delete(channel.id);
  await fetch(`/api/channels/${channel.id}`, { method: "DELETE" }).catch(() => {});
  sharedFiles.querySelector(`[data-channel="${channel.id}"]`)?.remove();
  if (!sharedFiles.children.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No files have been added yet";
    sharedFiles.append(empty);
  }
}

async function copy(text) {
  await navigator.clipboard.writeText(text);
}

function formatPercent(value) {
  return `${Math.max(0, Math.min(100, Math.round(value || 0)))}%`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}
