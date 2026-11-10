import { Worker } from "node:worker_threads";

// Bounded backlogs keep a slow hash worker from buffering upload bytes without limit.
const MAX_TRANSFER_BACKLOG = 4 * 1024 * 1024;
const MAX_TOTAL_BACKLOG = 32 * 1024 * 1024;
type Transfer = { backlog: number; failed: boolean; resolve?: (hash: string | undefined) => void };
let worker: Worker | undefined;
let stopped = false;
let nextId = 0;
let totalBacklog = 0;
let waiters: Array<() => void> = [];
const transfers = new Map<number, Transfer>();
function wakeWaiters() {
  const ready = waiters;
  waiters = [];
  for (const wake of ready) wake();
}
/** Chunks sent to a lost worker are gone with it, so none of its transfers can produce a hash any more. */
function failTransfers() {
  for (const transfer of transfers.values()) {
    transfer.failed = true;
    transfer.resolve?.(undefined);
  }
  transfers.clear();
  totalBacklog = 0;
  wakeWaiters();
}
function hashWorker() {
  if (worker) return worker;
  const created = new Worker(new URL("./hash-worker.ts", import.meta.url));
  worker = created;
  created.unref();
  created.on("message", (message: { id: number; processed?: number; hash?: string }) => {
    const transfer = transfers.get(message.id);
    if (message.processed !== undefined) {
      totalBacklog -= message.processed;
      if (transfer) transfer.backlog -= message.processed;
      wakeWaiters();
    }
    if (message.hash !== undefined && transfer) {
      transfers.delete(message.id);
      transfer.resolve?.(message.hash);
    }
  });
  const lost = (cause: string) => {
    if (worker !== created) return;
    worker = undefined;
    console.error(`Hash worker stopped (${cause}); its uploads finish without a hash`);
    failTransfers();
  };
  created.on("error", (error: Error) => lost(error.message));
  created.on("exit", (code) => lost(`exit code ${code}`));
  return created;
}
/**
 * Bun keeps a process alive while a worker has a message listener, even after unref(),
 * so shutdown has to end the worker or the process never exits after a hashed upload.
 */
export async function stopHashWorker() {
  stopped = true;
  const running = worker;
  worker = undefined;
  failTransfers();
  await running?.terminate();
}

let holders = 0;
/** Each running relay holds the worker; the last one to let go ends it, so a process whose relays all stopped can exit. */
export function holdHashWorker() {
  holders++;
  stopped = false;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (--holders === 0) await stopHashWorker();
  };
}

/** SHA-256 of one transfer, computed on a worker thread so hashing never stalls the relay's event loop. */
export class TransferHash {
  private readonly id = nextId++;
  private readonly transfer: Transfer = { backlog: 0, failed: false };
  private finished = false;
  constructor() {
    transfers.set(this.id, this.transfer);
  }
  /** Queues a copy of the chunk; resolves once the worker's backlog is small enough for more. */
  async update(chunk: Uint8Array) {
    if (this.finished || this.transfer.failed || stopped) return;
    // A copy with its own buffer: Buffer.slice would share, and the transfer would detach, the socket's memory.
    const copy = new Uint8Array(chunk);
    this.transfer.backlog += copy.byteLength;
    totalBacklog += copy.byteLength;
    hashWorker().postMessage({ id: this.id, chunk: copy }, [copy.buffer]);
    while (
      !this.finished &&
      !this.transfer.failed &&
      (this.transfer.backlog > MAX_TRANSFER_BACKLOG || totalBacklog > MAX_TOTAL_BACKLOG)
    ) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }
  /** Resolves undefined when the hash can't be computed: the worker failed or the server is stopping. */
  digest(): Promise<string | undefined> {
    this.finished = true;
    if (this.transfer.failed || stopped) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.transfer.resolve = resolve;
      hashWorker().postMessage({ id: this.id, done: true });
    });
  }
  cancel() {
    if (this.finished) return;
    this.finished = true;
    transfers.delete(this.id);
    worker?.postMessage({ id: this.id, cancel: true });
    wakeWaiters();
  }
}
