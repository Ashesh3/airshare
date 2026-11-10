import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type RunningServer = {
  base: string;
  close: () => Promise<void>;
  logs: () => string;
  /** With `realShutdown`: sends SIGTERM and resolves with the ms the process took to exit on its own (Infinity if killed after 5 s). */
  terminate: () => Promise<number>;
};

/**
 * `graceful` runs the server's own SIGTERM shutdown on close; a plain kill skips it on Windows.
 * `realShutdown` lets `terminate` deliver SIGTERM with no forced exit: a real signal where the
 * platform has one, the launcher's emitted SIGTERM on Windows.
 */
export async function startServer(
  env: Record<string, string> = {},
  { graceful = false, realShutdown = false } = {},
): Promise<RunningServer> {
  const launcher = graceful || (realShutdown && process.platform === "win32");
  const child = Bun.spawn([process.execPath, launcher ? "tests/graceful-server.ts" : "src/server.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    // An ambient deployment PUBLIC_URL must never leak into local fixtures.
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      DATA_DIR: ":memory:",
      PUBLIC_URL: "",
      ...(realShutdown ? { AIRSHARE_TEST_NATURAL_EXIT: "1" } : {}),
      ...env,
    },
    stdin: launcher ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  let resolveReady!: (value: string) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      output += decoder.decode(value, { stream: true });
      const match = output.match(/AirShare listening on http:\/\/[^:\s]+:(\d+)/);
      if (match) resolveReady(`http://127.0.0.1:${match[1]}`);
    }
  };
  const drains = [read(child.stdout), read(child.stderr)];
  void child.exited.then((code) => rejectReady(new Error(`Server exited ${code}: ${output}`)));
  const timer = setTimeout(() => rejectReady(new Error(`Server startup timed out: ${output}`)), 10_000);
  try {
    const base = await ready;
    return {
      base,
      logs: () => output,
      terminate: async () => {
        const started = Date.now();
        if (launcher) {
          const stdin = child.stdin as import("bun").FileSink;
          stdin.write("stop\n");
          await stdin.flush();
        } else child.kill("SIGTERM");
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, 5000);
        await child.exited;
        clearTimeout(timer);
        return killed ? Infinity : Date.now() - started;
      },
      close: async () => {
        if (graceful && child.exitCode === null) {
          const stdin = child.stdin as import("bun").FileSink;
          stdin.write("stop\n");
          await stdin.flush();
          const timer = setTimeout(() => child.kill(), 5000);
          await child.exited;
          clearTimeout(timer);
        } else child.kill();
        await child.exited;
        await Promise.all(drains);
      },
    };
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function createChannel(server: RunningServer, file: Record<string, unknown> = {}) {
  const response = await fetch(`${server.base}/api/channels`, {
    method: "POST",
    body: JSON.stringify(file),
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(3000),
  });
  if (response.status !== 201) throw new Error(`Create channel: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}

export async function channelStatus(server: RunningServer, channel: { id: string }) {
  return fetch(`${server.base}/api/channels/${channel.id}`, { signal: AbortSignal.timeout(3000) }).then((response) =>
    response.json(),
  ) as Promise<any>;
}

export async function until<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeout = 2500): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T;
  do {
    last = await probe();
    if (accept(last)) return last;
    await Bun.sleep(15);
  } while (Date.now() < deadline);
  throw new Error(`Condition did not become true: ${JSON.stringify(last!)}`);
}

/** Files in a data directory that still contain any of the given raw keys. */
export async function rawKeysIn(dir: string, keys: string[]) {
  const found: string[] = [];
  for (const name of await readdir(dir)) {
    const bytes = Buffer.from(await Bun.file(join(dir, name)).arrayBuffer());
    for (const key of keys) if (bytes.includes(key)) found.push(`${name}: ${key}`);
  }
  return found;
}

export async function temporaryDataDir() {
  const path = await mkdtemp(join(tmpdir(), "airshare-server-test-"));
  // Windows can hold SQLite files for a moment after the server process exits.
  return { path, remove: () => rm(path, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 }) };
}

export function sseReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    cancel: () => reader.cancel().catch(() => {}),
    async next(eventName?: string): Promise<{ event: string; data: any }> {
      while (true) {
        const index = buffer.indexOf("\n\n");
        if (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (event && data && (!eventName || event === eventName)) return { event, data: JSON.parse(data) };
          continue;
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("SSE closed before the expected event");
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}
