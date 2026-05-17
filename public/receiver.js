const channel = window.STATION_CHANNEL;
const statusText = document.querySelector("#status");
const download = document.querySelector("#download");

if (channel?.eventsUrl) {
  const events = new EventSource(channel.eventsUrl);
  events.addEventListener("status", (event) => {
    const status = JSON.parse(event.data);
    if (status.activeUpload) {
      statusText.textContent = "Sender is streaming the file now.";
    } else if (status.completedTransfers > 0) {
      statusText.textContent = "Transfer completed. Start another download to receive the next stream.";
    } else {
      statusText.textContent = "Ready. Click download and keep this page open.";
    }
  });
}

download?.addEventListener("click", () => {
  statusText.textContent = "Waiting for the sender to stream the file.";
});
