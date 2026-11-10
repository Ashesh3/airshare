import { createServer } from "./app";
import { config } from "./config";

const relay = await createServer(config);
/** How long a stopping relay waits for its connections to end before exiting regardless. */
const SHUTDOWN_GRACE_MS = 2000;
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  void relay.shutdown();
  // Metadata is already saved, so a handle that keeps the process alive (a half-sent request, a runtime quirk) only
  // delays a restart; container runtimes would kill it anyway after their own, longer grace.
  setTimeout(() => {
    console.warn(`Connections were still open ${SHUTDOWN_GRACE_MS} ms after the shutdown signal; exiting anyway.`);
    process.exit(0);
  }, SHUTDOWN_GRACE_MS).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log(`AirShare listening on http://${config.hostname}:${relay.port}`);
if (config.senderLease < 4000)
  console.warn(
    `SENDER_LEASE_MS=${config.senderLease} is shorter than a slow status poll; polling senders may flicker offline.`,
  );
if (config.hostGrace + config.senderLease < 30_000)
  console.warn(`HOST_GRACE_MS + SENDER_LEASE_MS is under 30 s; a brief network drop can end browser shares.`);
