// Test launcher: runs the server's registered SIGTERM handler when stdin receives a line.
import { Server } from "node:http";

// Lets a test reach the server while shutdown is in progress by holding the listener open.
const holdListener = Number(process.env.AIRSHARE_TEST_DELAY_CLOSE_MS ?? 0);
if (holdListener) {
  const close = Server.prototype.close;
  Server.prototype.close = function (this: Server, callback?: (error?: Error) => void) {
    setTimeout(() => close.call(this, callback), holdListener);
    return this;
  };
}
await import("../src/server");
process.stdin.once("data", () => {
  process.emit("SIGTERM");
  // Like a real SIGTERM, AIRSHARE_TEST_NATURAL_EXIT leaves exiting to the drained event loop.
  if (process.env.AIRSHARE_TEST_NATURAL_EXIT) process.stdin.destroy();
  else setTimeout(() => process.exit(0), 200 + holdListener);
});
export {};
