import { parentPort } from "node:worker_threads";

// Test hook: a chunk containing this marker makes the worker throw, so tests can check the relay recovers.
const failMarker = process.env.AIRSHARE_TEST_HASH_WORKER_FAIL;
// Hashes upload bytes off the relay thread; messages for one transfer arrive in order.
const hashers = new Map<number, InstanceType<typeof Bun.CryptoHasher>>();
parentPort!.on("message", (message: { id: number; chunk?: Uint8Array; done?: boolean; cancel?: boolean }) => {
  if (message.cancel) {
    hashers.delete(message.id);
    return;
  }
  if (failMarker && message.chunk && Buffer.from(message.chunk).includes(failMarker))
    throw new Error("Injected hash worker failure");
  let hasher = hashers.get(message.id);
  if (!hasher) hashers.set(message.id, (hasher = new Bun.CryptoHasher("sha256")));
  if (message.chunk) {
    hasher.update(message.chunk);
    parentPort!.postMessage({ id: message.id, processed: message.chunk.byteLength });
  }
  if (message.done) {
    hashers.delete(message.id);
    parentPort!.postMessage({ id: message.id, hash: hasher.digest("hex") });
  }
});
