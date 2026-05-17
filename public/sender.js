const channel = window.STATION_CHANNEL;
const input = document.querySelector("#send-file");
const statusText = document.querySelector("#status");

input?.addEventListener("change", async () => {
  const file = input.files?.[0];
  if (!file) return;
  statusText.textContent = "Streaming file to the waiting receiver.";

  try {
    const uploadUrl = new URL(channel.uploadUrl);
    uploadUrl.pathname = uploadUrl.pathname.replace(/\/[^/]*$/, `/${encodeURIComponent(file.name)}`);
    await uploadFile(uploadUrl, file);
    statusText.textContent = "Transfer complete.";
  } catch (error) {
    statusText.textContent = `Transfer failed: ${error.message}`;
  } finally {
    input.value = "";
  }
});

function uploadFile(uploadUrl, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl, true);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-airshare-no-redirect", "1");
    xhr.setRequestHeader("x-airshare-file-size", String(file.size));
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(xhr.responseText || `Upload failed with HTTP ${xhr.status}`));
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("abort", () => reject(new DOMException("Upload aborted", "AbortError")));
    xhr.send(file);
  });
}
