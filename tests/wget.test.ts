import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startServer, temporaryDataDir, until, type RunningServer } from "./server-helper";

// Invoke a real executable, never PowerShell's wget alias or BusyBox's applet.
const wgetExecutable = (() => {
  const executable = Bun.which(process.platform === "win32" ? "wget.exe" : "wget");
  if (!executable) return null;
  try {
    const version = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
    return version.exitCode === 0 && /^GNU Wget\s/m.test(new TextDecoder().decode(version.stdout)) ? executable : null;
  } catch {
    return null;
  }
})();

type WgetProcess = {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  result: Promise<{ code: number; log: string }>;
  log: () => string;
  stop: () => Promise<void>;
};
const servers: RunningServer[] = [];
const directories: Awaited<ReturnType<typeof temporaryDataDir>>[] = [];
const clients: WgetProcess[] = [];
const TEST_TIMEOUT = 20_000;

async function bounded<T>(promise: Promise<T>, timeout: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message())), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

afterEach(async () => {
  const stopped = await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
  const closed = await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  const removed = await Promise.allSettled(directories.splice(0).map((directory) => directory.remove()));
  for (const result of [...stopped, ...closed, ...removed]) {
    if (result.status === "rejected") throw result.reason;
  }
});

async function fixture() {
  const directory = await temporaryDataDir();
  directories.push(directory);
  const input = join(directory.path, "input");
  const output = join(directory.path, "output");
  await Promise.all([mkdir(input), mkdir(output)]);
  const server = await startServer({ PUBLIC_URL: "" });
  servers.push(server);
  return { server, input, output, path: directory.path };
}

function wget(args: string[], cwd: string): WgetProcess {
  const child = Bun.spawn(
    [wgetExecutable!, "--no-config", "--no-proxy", "--tries=1", "--timeout=8", "--server-response", ...args],
    {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    },
  );
  let log = "";
  const drain = async (stream: ReadableStream<Uint8Array>, record: boolean) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (record) log = (log + decoder.decode(value, { stream: true })).slice(-64 * 1024);
    }
  };
  const drains = [drain(child.stdout, false), drain(child.stderr, true)];
  const result = child.exited.then(async (code) => {
    await Promise.all(drains);
    return { code, log };
  });
  const client: WgetProcess = {
    child,
    result,
    log: () => log,
    async stop() {
      if (child.exitCode === null) {
        try {
          child.kill();
        } catch {}
      }
      try {
        await bounded(child.exited, 2000, () => "GNU Wget did not terminate");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
        await bounded(child.exited, 2000, () => "GNU Wget did not terminate after SIGKILL");
      }
      await bounded(result, 1500, () => `GNU Wget output did not close: ${log}`);
    },
  };
  clients.push(client);
  return client;
}

function headerValues(log: string, name: string) {
  const lines = log.split(/\r?\n/);
  lines.pop(); // Wait for complete lines before using a capability URL.
  return lines.flatMap((line) => {
    const colon = line.indexOf(":");
    return colon > 0 && line.slice(0, colon).trim().toLowerCase() === name ? [line.slice(colon + 1).trim()] : [];
  });
}

async function discovery(client: WgetProcess, header: string) {
  const result = await until(
    async () => {
      const value = headerValues(client.log(), header)[0];
      if (value) return value;
      if (client.child.exitCode !== null) {
        const ended = await client.result;
        throw new Error(`GNU Wget exited before publishing ${header}: ${ended.code}\n${ended.log}`);
      }
      return undefined;
    },
    (value) => Boolean(value),
    5000,
  );
  return result!;
}

function statusUrl(uploadUrl: string) {
  const url = new URL(uploadUrl);
  url.pathname = `/api/channels/${url.pathname.match(/^\/(?:u|api\/channels)\/([^/]+)/)![1]}`;
  return url.href;
}

async function status(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error(`Channel status returned HTTP ${response.status}`);
  return response.json();
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe.skipIf(!wgetExecutable)("GNU Wget integration (GNU Wget executable required)", () => {
  for (const variant of [
    { name: "regular POST follows 307 and hosts the same file for two sequential receivers", flags: [] },
    { name: "an eager POST with Connection close follows 307 and keeps hosting", flags: ["--no-http-keep-alive"] },
  ]) {
    test(
      variant.name,
      async () => {
        const { server, input, path } = await fixture();
        const filename = "wget-repeated.bin";
        const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 29 }, (_, index) => (index * 43 + 11) & 255);
        const source = join(input, filename);
        await writeFile(source, bytes);
        const sender = wget(
          [
            ...variant.flags,
            `--post-file=${source}`,
            "--max-redirect=1000000",
            "--output-document=-",
            `${server.base}/xfr/${filename}`,
          ],
          path,
        );
        const downloadUrl = await discovery(sender, "x-airshare-download-url");
        const uploadUrl = await discovery(sender, "x-airshare-upload-url");
        expect(new URL(downloadUrl).origin).toBe(server.base);
        expect(headerValues(sender.log(), "com.station307.transfer.url")[0]).toBe(downloadUrl);
        const active = await until(
          () => status(statusUrl(uploadUrl)),
          (value) => value.activeUpload,
        );
        expect(active.file.filename).toBe(filename);
        expect(active.file.contentLength).toBe(bytes.length);

        for (let index = 1; index <= 2; index += 1) {
          const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(6000) });
          expect(response.status).toBe(200);
          expect(response.headers.get("content-length")).toBe(String(bytes.length));
          expect(response.headers.get("content-type")).toBe("application/octet-stream");
          const received = new Uint8Array(await response.arrayBuffer());
          expect(received.byteLength).toBe(bytes.length);
          expect(digest(received)).toBe(digest(bytes));
          await until(
            () => status(statusUrl(uploadUrl)),
            (value) => value.completedTransfers === index && value.activeUpload,
          );
          expect(sender.child.exitCode).toBeNull();
        }
        await sender.stop();
        const stopped = await until(
          () => status(statusUrl(uploadUrl)),
          (value) => !value.activeUpload && !value.senderOnline,
        );
        expect(stopped.completedTransfers).toBe(2);
        expect(stopped.waitingReceivers).toBe(0);
        expect(stopped.activeReceivers).toBe(0);
      },
      TEST_TIMEOUT,
    );
  }

  test(
    "receiver-first --content-disposition saves the eventual sender filename with matching bytes and size",
    async () => {
      const { server, output } = await fixture();
      const receiver = wget(["--content-disposition", `${server.base}/xfr`], output);
      const uploadUrl = await discovery(receiver, "x-airshare-upload-url");
      await until(
        () => status(statusUrl(uploadUrl)),
        (value) => value.waitingReceivers === 1,
      );
      const filename = "received-via-wget.txt";
      const bytes = new TextEncoder().encode(
        "Synthetic receiver-first GNU Wget transfer.\nThe filename is known only when this upload starts.\n",
      );
      // The printed sender link ends in "/" until a sender names the file.
      expect(uploadUrl.endsWith("/")).toBe(true);
      const upload = await fetch(new URL(encodeURIComponent(filename), uploadUrl), {
        method: "POST",
        body: bytes,
        headers: {
          "content-type": "text/plain",
          "x-airshare-file-size": String(bytes.length),
          "x-airshare-no-redirect": "1",
        },
        signal: AbortSignal.timeout(6000),
      });
      expect(upload.status).toBe(200);
      const result = await bounded(receiver.result, 8000, () => `GNU Wget receiver did not finish: ${receiver.log()}`);
      if (result.code !== 0) throw new Error(`GNU Wget receiver exited ${result.code}: ${result.log}`);
      expect(result.code).toBe(0);
      expect(await readdir(output)).toEqual([filename]);
      const received = await readFile(join(output, filename));
      expect(received.byteLength).toBe(bytes.length);
      expect(digest(received)).toBe(digest(bytes));
      expect(headerValues(result.log, "content-disposition").at(-1)).toContain(filename);
      expect(headerValues(result.log, "content-type").at(-1)).toBe("text/plain");
      expect(headerValues(result.log, "content-length").at(-1)).toBe(String(bytes.length));
      expect((await status(statusUrl(uploadUrl))).completedTransfers).toBe(1);
    },
    TEST_TIMEOUT,
  );

  // Station307's recipes with only the host changed.
  for (const variant of [
    {
      name: "wget --post-file file <host> hosts the file under a timestamped name",
      path: "",
      expected: /^airshare-\d{8}-\d{6}\.bin$/,
    },
    {
      name: "wget --post-file file <host>/name hosts the file under that name",
      path: "/station-wget.bin",
      expected: /^station-wget\.bin$/,
    },
  ]) {
    test(
      variant.name,
      async () => {
        const { server, input, path } = await fixture();
        const bytes = Uint8Array.from({ length: 700 * 1024 + 9 }, (_, index) => (index * 31 + 7) & 255);
        const source = join(input, "station-wget.bin");
        await writeFile(source, bytes);
        const sender = wget([`--post-file=${source}`, "--output-document=-", `${server.base}${variant.path}`], path);
        const transferUrl = await discovery(sender, "com.station307.human.transfer.url");
        expect(headerValues(sender.log(), "com.station307.human.info")[0]).toBe(
          "Copy one of the two URLs, or scan the QR code",
        );
        expect(headerValues(sender.log(), "com.station307.human.web.url")[0]).toMatch(/\/r\/[1-9A-HJ-NP-Za-km-z]{22}$/);
        const response = await fetch(transferUrl, { signal: AbortSignal.timeout(6000) });
        expect(response.status).toBe(200);
        const name = decodeURIComponent(
          response.headers.get("content-disposition")!.match(/filename\*=UTF-8''([^;]+)/)![1]!,
        );
        expect(name).toMatch(variant.expected);
        expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(digest(bytes));
        expect(sender.child.exitCode).toBeNull();
      },
      TEST_TIMEOUT,
    );
  }
});
