import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChannel, sseReader, startServer, temporaryDataDir, until, type RunningServer } from "./server-helper";

const curlExecutable = Bun.which(process.platform === "win32" ? "curl.exe" : "curl");
const servers: RunningServer[] = [];
const directories: Awaited<ReturnType<typeof temporaryDataDir>>[] = [];
const processes: CurlProcess[] = [];
const TEST_TIMEOUT = 20_000;

type HeaderBlock = { status: number; headers: Record<string, string> };
type CurlResult = { code: number; stdout: string; stderr: string };
type CurlProcess = {
  child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  result: Promise<CurlResult>;
  stderr: () => string;
  stop: () => Promise<void>;
};

beforeAll(() => {
  if (!curlExecutable) throw new Error("CLI integration tests require curl on PATH (curl.exe on Windows).");
});

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
  // Close clients before listeners and remove only directories allocated by this
  // test file, after every child has released its output/header handles.
  const stopped = await Promise.allSettled(processes.splice(0).map((child) => child.stop()));
  const closed = await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  const removed = await Promise.allSettled(directories.splice(0).map((directory) => directory.remove()));
  for (const result of [...stopped, ...closed, ...removed]) {
    if (result.status === "rejected") throw result.reason;
  }
});

async function fixture(env: Record<string, string> = {}) {
  const directory = await temporaryDataDir();
  directories.push(directory);
  const input = join(directory.path, "input");
  const output = join(directory.path, "output");
  await Promise.all([mkdir(input), mkdir(output)]);
  const server = await startServer(env);
  servers.push(server);
  return { server, input, output, path: directory.path };
}

function curl(args: string[], cwd: string, input?: Uint8Array): CurlProcess {
  const child = Bun.spawn(
    [
      curlExecutable!,
      "-q",
      "--silent",
      "--show-error",
      "--noproxy",
      "*",
      "--connect-timeout",
      "3",
      "--max-time",
      "15",
      ...args,
    ],
    { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  let stdout = "";
  let stderr = "";
  const drain = async (stream: ReadableStream<Uint8Array>, append: (value: string) => void) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      append(decoder.decode(value, { stream: true }));
    }
  };
  const drains = [
    drain(child.stdout, (value) => {
      stdout = (stdout + value).slice(-64 * 1024);
    }),
    drain(child.stderr, (value) => {
      stderr = (stderr + value).slice(-64 * 1024);
    }),
  ];
  if (input) child.stdin.write(input);
  // Feed stdin immediately, before the initial redirect. Waiting for the redirect
  // first would conceal a server that consumes non-rewindable input too early.
  const inputClosed = Promise.resolve(child.stdin.end()).catch((error) => {
    stderr += `\nstdin: ${String(error)}`;
  });
  const result = child.exited.then(async (code) => {
    await Promise.all([...drains, inputClosed]);
    return { code, stdout, stderr };
  });
  const process: CurlProcess = {
    child,
    result,
    stderr: () => stderr,
    async stop() {
      if (child.exitCode === null) {
        try {
          child.kill();
        } catch {}
      }
      try {
        await bounded(child.exited, 2000, () => "curl did not terminate");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
        await bounded(child.exited, 2000, () => "curl did not terminate after SIGKILL");
      }
      await bounded(result, 1500, () => `curl output did not close: ${stderr}`);
    },
  };
  processes.push(process);
  return process;
}

async function succeeded(process: CurlProcess): Promise<CurlResult> {
  const result = await bounded(process.result, 8000, () => `curl did not finish: ${process.stderr()}`);
  if (result.code !== 0) throw new Error(`curl exited ${result.code}: ${result.stderr}\n${result.stdout}`);
  return result;
}

async function readHeaders(path: string): Promise<HeaderBlock[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const fragments = text.split(/\r?\n\r?\n/);
  fragments.pop(); // A partial final block is not safe for link discovery yet.
  return fragments.flatMap((fragment) => {
    const lines = fragment.split(/\r?\n/);
    const status = lines.shift()?.match(/^HTTP\/\S+ (\d{3})/);
    if (!status) return [];
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).toLowerCase();
      // HTTP strips only spaces and tabs; String.trim would also strip the QR rows' no-break spaces.
      const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "");
      // Repeated fields, such as the QR code rows, keep every line.
      headers[name] = name in headers ? `${headers[name]}\n${value}` : value;
    }
    return [{ status: Number(status[1]), headers }];
  });
}

async function discovery(process: CurlProcess, path: string, header: string) {
  const block = await until(
    async () => {
      const found = (await readHeaders(path)).find(
        (candidate) => candidate.status === 307 && candidate.headers[header],
      );
      if (found) return found;
      if (process.child.exitCode !== null) {
        const ended = await process.result;
        throw new Error(`curl exited before publishing ${header}: ${ended.code} ${ended.stderr}`);
      }
      return undefined;
    },
    (value) => value !== undefined,
    5000,
  );
  return block!;
}

function senderStatusUrl(uploadUrl: string) {
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
function payload(size: number) {
  return Uint8Array.from({ length: size }, (_, index) => (index * 37 + 19) & 255);
}

describe("real curl workflows", () => {
  test(
    "regular-file hosting discovers its basename and serves two complete sequential downloads until cancelled",
    async () => {
      const { server, input, output, path } = await fixture();
      const filename = "repeat payload.bin";
      const bytes = payload(2 * 1024 * 1024 + 31);
      const source = join(input, filename);
      const headers = join(path, "sender.headers");
      await writeFile(source, bytes);
      const sender = curl(["-T", source, "-L", "--max-redirs", "-1", "-D", headers, `${server.base}/xfr/`], path);
      const initial = await discovery(sender, headers, "x-airshare-download-url");
      const downloadUrl = initial.headers["x-airshare-download-url"]!;
      const uploadUrl = initial.headers["x-airshare-upload-url"]!;
      expect(new URL(downloadUrl).origin).toBe(server.base);
      expect(initial.headers["com.station307.transfer.url"]).toBe(downloadUrl);
      expect(initial.headers["com.station307.human.transfer.url"]).toBe(downloadUrl);
      expect(initial.headers["com.station307.url"]).toBe(downloadUrl);
      expect(initial.headers["com.station307.located-at"]).toBe(downloadUrl);
      const current = await until(
        () => status(senderStatusUrl(uploadUrl)),
        (value) => value.activeUpload,
      );
      expect(current.file.filename).toBe(filename);
      expect(current.file.contentLength).toBe(bytes.length);
      expect(initial.headers["com.station307.human.qr-code"]).toMatch(/[█▀▄]/);

      for (let index = 1; index <= 2; index += 1) {
        const destination = join(output, `received-${index}.bin`);
        const receiveHeaders = join(path, `receiver-${index}.headers`);
        const receiver = curl(["-f", "-L", "-D", receiveHeaders, "-o", destination, downloadUrl], output);
        await succeeded(receiver);
        const received = await readFile(destination);
        expect(received.byteLength).toBe(bytes.length);
        expect(digest(received)).toBe(digest(bytes));
        const final = (await readHeaders(receiveHeaders)).findLast((block) => block.status === 200)!;
        expect(final.headers["content-length"]).toBe(String(bytes.length));
        expect(final.headers["content-disposition"]).toContain(filename);
        await until(
          () => status(senderStatusUrl(uploadUrl)),
          (value) => value.completedTransfers === index && value.activeUpload,
        );
        expect(sender.child.exitCode).toBeNull();
      }
      const redirects = (await readHeaders(headers)).filter((block) => block.status === 307);
      expect(redirects.length).toBeGreaterThanOrEqual(3);
      // Only the first redirect introduces the share, so `| grep human` prints it once.
      for (const replay of redirects.slice(1))
        expect(Object.keys(replay.headers).filter((name) => name.includes("human"))).toEqual([]);
      await sender.stop();
      const stopped = await until(
        () => status(senderStatusUrl(uploadUrl)),
        (value) => !value.activeUpload && !value.senderOnline,
      );
      expect(stopped.completedTransfers).toBe(2);
      expect(stopped.waitingReceivers).toBe(0);
      expect(stopped.activeReceivers).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "a large body sent without Expect can follow the early creation redirect and deliver intact",
    async () => {
      const { server, input, output, path } = await fixture();
      const bytes = payload(2 * 1024 * 1024 + 53);
      const source = join(input, "immediate.bin");
      const headers = join(path, "immediate-sender.headers");
      await writeFile(source, bytes);
      const sender = curl(
        ["-H", "Expect:", "-T", source, "-L", "--max-redirs", "-1", "-D", headers, `${server.base}/xfr/`],
        path,
      );
      const initial = await discovery(sender, headers, "x-airshare-download-url");
      const destination = join(output, "immediate.bin");
      const receiver = curl(["-f", "-L", "-o", destination, initial.headers["x-airshare-download-url"]!], output);
      await succeeded(receiver);
      expect(digest(await readFile(destination))).toBe(digest(bytes));
      const url = senderStatusUrl(initial.headers["x-airshare-upload-url"]!);
      await until(
        () => status(url),
        (value) => value.completedTransfers === 1 && value.activeUpload,
      );
      expect(sender.child.exitCode).toBeNull();
    },
    TEST_TIMEOUT,
  );

  test(
    "receiver cancellation leaves a regular sender hosting the complete file for a later receiver",
    async () => {
      const { server, input, output, path } = await fixture();
      const bytes = payload(8 * 1024 * 1024 + 73);
      const source = join(input, "after-cancellation.bin");
      const headers = join(path, "recovery-sender.headers");
      await writeFile(source, bytes);
      // Bound the sender's rate so the first receiver can cancel after real bytes
      // arrive, before loopback buffers could contain the whole synthetic file.
      const sender = curl(
        ["--limit-rate", "4M", "-T", source, "-L", "--max-redirs", "-1", "-D", headers, `${server.base}/xfr/`],
        path,
      );
      const initial = await discovery(sender, headers, "x-airshare-download-url");
      const downloadUrl = initial.headers["x-airshare-download-url"]!;
      const channelUrl = senderStatusUrl(initial.headers["x-airshare-upload-url"]!);
      const abort = new AbortController();
      try {
        const response = await fetch(downloadUrl, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        const first = await bounded(reader.read(), 3000, () => "First receiver did not receive any bytes");
        expect(first.value!.byteLength).toBeGreaterThan(0);
        expect(first.value!.byteLength).toBeLessThan(bytes.length);
        abort.abort();
        await reader.cancel().catch(() => {});
      } finally {
        abort.abort();
      }

      await until(
        async () => {
          if (sender.child.exitCode !== null) {
            const ended = await sender.result;
            throw new Error(
              `curl stopped hosting after receiver cancellation: ${ended.code}\n${ended.stderr}\n${ended.stdout}`,
            );
          }
          return status(channelUrl);
        },
        (value) => value.activeUpload && value.activeReceivers === 0 && value.bytesTransferred === 0,
        5000,
      );
      const destination = join(output, "complete-after-cancellation.bin");
      const receiver = curl(["-f", "-L", "-o", destination, downloadUrl], output);
      await succeeded(receiver);
      const received = await readFile(destination);
      expect(received.byteLength).toBe(bytes.length);
      expect(digest(received)).toBe(digest(bytes));
      await until(
        () => status(channelUrl),
        (value) => value.activeUpload && value.completedTransfers === 1,
      );
      expect(sender.child.exitCode).toBeNull();
      await sender.stop();
      const stopped = await until(
        () => status(channelUrl),
        (value) => !value.activeUpload && !value.senderOnline,
      );
      expect(stopped.completedTransfers).toBe(1);
      expect(stopped.waitingReceivers).toBe(0);
      expect(stopped.activeReceivers).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "receiver-first -f -L -J -O uses the sender's eventual filename, content type and size",
    async () => {
      const { server, input, output, path } = await fixture();
      const receiveHeaders = join(path, "receiver.headers");
      const receiver = curl(["-f", "-L", "-J", "-O", "-D", receiveHeaders, `${server.base}/xfr`], output);
      const initial = await discovery(receiver, receiveHeaders, "x-airshare-upload-url");
      const uploadUrl = initial.headers["x-airshare-upload-url"]!;
      // Without a name yet, the printed sender link ends in "/" so curl -T appends the local file name.
      expect(uploadUrl).toMatch(/\/u\/[1-9A-HJ-NP-Za-km-z]{22}\/$/);
      expect(initial.headers["com.station307.human.transfer.url"]).toBe(uploadUrl);
      await until(
        () => status(senderStatusUrl(uploadUrl)),
        (value) => value.waitingReceivers === 1,
      );
      expect(await readdir(output)).toEqual([]);
      const filename = "quarterly report.csv";
      const bytes = new TextEncoder().encode("name,value\r\nalpha,42\r\nbeta,17\r\n");
      const source = join(input, filename);
      await writeFile(source, bytes);
      const sender = curl(
        ["-T", source, "-H", "content-type: text/csv", "-H", "x-airshare-no-redirect: 1", uploadUrl],
        path,
      );
      await Promise.all([succeeded(sender), succeeded(receiver)]);
      expect(await readdir(output)).toEqual([filename]);
      expect(digest(await readFile(join(output, filename)))).toBe(digest(bytes));
      const final = (await readHeaders(receiveHeaders)).findLast((block) => block.status === 200)!;
      expect(final.headers["content-disposition"]).toContain(filename);
      expect(final.headers["content-type"]).toBe("text/csv");
      expect(final.headers["content-length"]).toBe(String(bytes.length));
      expect((await status(senderStatusUrl(uploadUrl))).completedTransfers).toBe(1);
    },
    TEST_TIMEOUT,
  );

  test(
    "prepared piped stdin sends its complete unknown-length payload directly and exits after one receiver",
    async () => {
      const { server, output, path } = await fixture();
      const bytes = payload(3 * 1024 * 1024 + 17);
      const prepareHeaders = join(path, "prepare.headers");
      const preparation = curl(
        ["-f", "-X", "POST", "-H", "content-length: 0", "-D", prepareHeaders, `${server.base}/xfr/log.txt?prepare=1`],
        path,
      );
      const prepared = await succeeded(preparation);
      const preparedBlocks = await readHeaders(prepareHeaders);
      expect(preparedBlocks.map((block) => block.status)).toEqual([201]);
      const uploadUrl = prepared.stdout.trim();
      expect(uploadUrl).toBe(preparedBlocks[0]!.headers["x-airshare-upload-url"]);
      const downloadUrl = preparedBlocks[0]!.headers["x-airshare-download-url"]!;
      expect(new URL(uploadUrl).origin).toBe(server.base);
      expect((await status(senderStatusUrl(uploadUrl))).file.contentLength).toBeUndefined();
      const headers = join(path, "stdin.headers");
      const sender = curl(["-f", "-T", "-", "-D", headers, uploadUrl], path, bytes);
      const active = await until(
        () => status(senderStatusUrl(uploadUrl)),
        (value) => value.activeUpload,
      );
      expect(active.file.contentLength).toBeUndefined();
      const destination = join(output, "log.txt");
      const receiverHeaders = join(path, "stdin-receiver.headers");
      const receiver = curl(["-f", "-L", "-D", receiverHeaders, "-o", destination, downloadUrl], output);
      const [, sent] = await Promise.all([succeeded(receiver), succeeded(sender)]);
      expect(sent.code).toBe(0);
      const contents = await readFile(destination);
      expect(contents.byteLength).toBe(bytes.length);
      expect(digest(contents)).toBe(digest(bytes));
      const uploaded = (await readHeaders(headers)).filter((block) => block.status >= 200);
      expect(uploaded.map((block) => block.status)).toEqual([200]);
      const received = (await readHeaders(receiverHeaders)).findLast((block) => block.status === 200)!;
      expect(received.headers["content-length"]).toBeUndefined();
      expect(received.headers["content-disposition"]).toContain("log.txt");
      const completed = await until(
        () => status(senderStatusUrl(uploadUrl)),
        (value) => !value.activeUpload,
      );
      expect(completed.completedTransfers).toBe(1);
      expect(completed.senderOnline).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "unprepared unknown-length creation is rejected without a redirect or an allocated share",
    async () => {
      const { server, path } = await fixture({ MAX_CHANNELS: "1" });
      for (const method of ["PUT", "POST"]) {
        const headers = join(path, `unprepared-${method}.headers`);
        const sender = curl(
          ["--fail-with-body", "-X", method, "-T", "-", "-D", headers, `${server.base}/xfr/unprepared.txt`],
          path,
          payload(64 * 1024 + 7),
        );
        const result = await bounded(
          sender.result,
          6000,
          () => `Unprepared stdin was not rejected: ${sender.stderr()}`,
        );
        expect(result.code).not.toBe(0);
        expect(result.stdout).toContain("prepare=1");
        const blocks = (await readHeaders(headers)).filter((block) => block.status >= 200);
        expect(blocks.map((block) => block.status)).toEqual([411]);
        expect(blocks[0]!.headers["location"]).toBeUndefined();
        expect(blocks[0]!.headers["x-airshare-upload-url"]).toBeUndefined();
        expect(blocks[0]!.headers["x-airshare-download-url"]).toBeUndefined();
        expect(blocks[0]!.headers["x-airshare-human-info"]).toContain(
          `curl -fsS -X POST -D /dev/stderr '${server.base}/xfr/unprepared.txt?prepare=1'`,
        );
      }
      expect((await createChannel(server, { filename: "no-rejected-input-leak.txt" })).file.filename).toBe(
        "no-rejected-input-leak.txt",
      );
    },
    TEST_TIMEOUT,
  );

  test(
    "a zero-byte CLI file downloads with Content-Length zero and remains available to the next receiver",
    async () => {
      const { server, input, output, path } = await fixture();
      const source = join(input, "empty.bin");
      await writeFile(source, new Uint8Array());
      const headers = join(path, "empty-sender.headers");
      const sender = curl(["-T", source, "-L", "--max-redirs", "-1", "-D", headers, `${server.base}/xfr/`], path);
      const initial = await discovery(sender, headers, "x-airshare-download-url");
      for (let index = 1; index <= 2; index += 1) {
        const destination = join(output, `empty-${index}.bin`);
        const receiverHeaders = join(path, `empty-receiver-${index}.headers`);
        const receiver = curl(
          ["-f", "-L", "-D", receiverHeaders, "-o", destination, initial.headers["x-airshare-download-url"]!],
          output,
        );
        await succeeded(receiver);
        expect((await readFile(destination)).byteLength).toBe(0);
        const final = (await readHeaders(receiverHeaders)).findLast((block) => block.status === 200)!;
        expect(final.headers["content-length"]).toBe("0");
        expect(final.headers["content-disposition"]).toContain("empty.bin");
        await until(
          () => status(senderStatusUrl(initial.headers["x-airshare-upload-url"]!)),
          (value) => value.activeUpload && value.completedTransfers === index,
        );
        expect(sender.child.exitCode).toBeNull();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "cancelling a sender waiting for its first receiver releases presence and lets its idle channel expire",
    async () => {
      const { server, input, path } = await fixture({
        MAX_CHANNELS: "1",
        CHANNEL_TTL_MS: "250",
        CLEANUP_INTERVAL_MS: "25",
      });
      const source = join(input, "cancel.bin");
      await writeFile(source, payload(8192));
      const headers = join(path, "cancel.headers");
      const sender = curl(["-T", source, "-L", "--max-redirs", "-1", "-D", headers, `${server.base}/xfr/`], path);
      const initial = await discovery(sender, headers, "x-airshare-upload-url");
      const url = senderStatusUrl(initial.headers["x-airshare-upload-url"]!);
      await until(
        () => status(url),
        (value) => value.activeUpload && value.senderOnline,
      );
      await sender.stop();
      const stopped = await until(
        () => status(url),
        (value) => !value.activeUpload && !value.senderOnline,
      );
      expect(stopped.completedTransfers).toBe(0);
      expect(stopped.waitingReceivers).toBe(0);
      expect(stopped.activeReceivers).toBe(0);
      // Stop reading status while waiting: channel activity may refresh its TTL.
      await Bun.sleep(550);
      expect((await fetch(url, { signal: AbortSignal.timeout(2500) })).status).toBe(410);
      expect((await createChannel(server, { filename: "capacity-reclaimed.txt" })).file.filename).toBe(
        "capacity-reclaimed.txt",
      );
    },
    TEST_TIMEOUT,
  );
});

const BASE58_KEY = "[1-9A-HJ-NP-Za-km-z]{22}";
const HUMAN_INFO = "Copy one of the two URLs, or scan the QR code";
const HUMAN_HEADERS = [
  "com.station307.human.info",
  "com.station307.human.qr-code",
  "com.station307.human.transfer.url",
  "com.station307.human.web.url",
  "x-airshare-human-info",
];
const curlAgent = { "user-agent": "curl/8.16.0" };
const wgetAgent = { "user-agent": "Wget/1.25.0" };

function humanHeaders(block: HeaderBlock) {
  return Object.fromEntries(Object.entries(block.headers).filter(([name]) => name.includes("human")));
}

function expectTerminalQr(rows: string | undefined) {
  const lines = (rows ?? "").split("\n");
  expect(lines.length).toBeGreaterThan(10);
  expect(lines.some((line) => /[█▀▄]/.test(line))).toBe(true);
  // HTTP trims edge spaces, so each row's quiet zone ends in no-break spaces and needs no guard characters.
  for (const line of lines) expect(line).toMatch(/^\u00a0+[ █▀▄]*\u00a0+$/);
}

describe("Station307 terminal recipes with only the host changed", () => {
  test(
    "curl -T file -s -L -D - <host>: grep human shows the two receiver links, the info line and the QR code",
    async () => {
      const { server, input, output, path } = await fixture();
      const filename = "station-recipe.bin";
      const bytes = payload(512 * 1024 + 7);
      const source = join(input, filename);
      const headers = join(path, "station-sender.headers");
      await writeFile(source, bytes);
      // With no path, curl appends the local file name: PUT /station-recipe.bin.
      const sender = curl(["-T", source, "-s", "-L", "-D", headers, server.base], path);
      const initial = await discovery(sender, headers, "com.station307.human.transfer.url");
      const human = humanHeaders(initial);
      expect(Object.keys(human).sort()).toEqual(HUMAN_HEADERS);
      expect(human["com.station307.human.info"]).toBe(HUMAN_INFO);
      expect(human["x-airshare-human-info"]).toBe(HUMAN_INFO);
      const transferUrl = human["com.station307.human.transfer.url"]!;
      const webUrl = human["com.station307.human.web.url"]!;
      expect(transferUrl).toMatch(new RegExp(`^${server.base}/l/${BASE58_KEY}/station-recipe\\.bin$`));
      expect(webUrl).toMatch(new RegExp(`^${server.base}/r/${BASE58_KEY}$`));
      // Nothing a sender could use appears in the lines meant for sharing.
      expect(Object.values(human).some((value) => /\/(u|s|send|api)\//.test(value))).toBe(false);
      expect(initial.headers["x-airshare-receiver-page-url"]).toBe(webUrl);
      expect(initial.headers["x-airshare-sender-page-url"]).toBeUndefined();
      expect(initial.headers["x-airshare-human-url"]).toBeUndefined();
      expectTerminalQr(human["com.station307.human.qr-code"]);

      const receiver = curl(["-f", "-L", "-J", "-O", transferUrl], output);
      await succeeded(receiver);
      expect(await readdir(output)).toEqual([filename]);
      expect(digest(await readFile(join(output, filename)))).toBe(digest(bytes));
      expect(sender.child.exitCode).toBeNull();
    },
    TEST_TIMEOUT,
  );

  test(
    "curl -s -J -O -L -D - <host>: grep human shows sender links, and curl -T to the printed URL keeps its name",
    async () => {
      const { server, input, output, path } = await fixture();
      const headers = join(path, "station-receiver.headers");
      const receiver = curl(["-f", "-s", "-J", "-O", "-L", "-D", headers, server.base], output);
      const initial = await discovery(receiver, headers, "com.station307.human.transfer.url");
      const human = humanHeaders(initial);
      expect(Object.keys(human).sort()).toEqual(HUMAN_HEADERS);
      const transferUrl = human["com.station307.human.transfer.url"]!;
      const webUrl = human["com.station307.human.web.url"]!;
      expect(transferUrl).toMatch(new RegExp(`^${server.base}/u/${BASE58_KEY}/$`));
      expect(webUrl).toMatch(new RegExp(`^${server.base}/send/${BASE58_KEY}$`));
      expect(initial.headers["x-airshare-sender-page-url"]).toBe(webUrl);
      expect(initial.headers["x-airshare-upload-url"]).toBe(transferUrl);
      expectTerminalQr(human["com.station307.human.qr-code"]);
      await until(
        () => status(senderStatusUrl(transferUrl)),
        (value) => value.waitingReceivers === 1,
      );

      const filename = "named-by-sender.tar";
      const bytes = payload(300 * 1024 + 3);
      const source = join(input, filename);
      await writeFile(source, bytes);
      const sender = curl(["-T", source, "-s", transferUrl], path);
      await Promise.all([succeeded(sender), succeeded(receiver)]);
      expect(await readdir(output)).toEqual([filename]);
      expect(digest(await readFile(join(output, filename)))).toBe(digest(bytes));
    },
    TEST_TIMEOUT,
  );

  test(
    "tar ... | curl -s -L -T - -D - <host>/name | grep human shows how to prepare the pipe",
    async () => {
      const { server, path } = await fixture({ MAX_CHANNELS: "1" });
      const piped = curl(
        ["-s", "-L", "-T", "-", "-D", "-", `${server.base}/folder.tar.gz`],
        path,
        payload(96 * 1024 + 5),
      );
      const result = await bounded(piped.result, 6000, () => `The unprepared pipe was not answered: ${piped.stderr()}`);
      const grepped = result.stdout.split(/\r?\n/).filter((line) => line.includes("human"));
      expect(grepped).toEqual([
        `x-airshare-human-info: A pipe can't be resent after a redirect, so prepare its upload URL first: UPLOAD_URL=$(curl -fsS -X POST -D /dev/stderr '${server.base}/folder.tar.gz?prepare=1'), then pipe into: curl -T - "$UPLOAD_URL"`,
      ]);
      expect(result.stdout).toMatch(/^HTTP\/1\.1 411 /m);
      // Nothing was allocated for the refused pipe.
      expect((await createChannel(server, { filename: "room-left.txt" })).file.filename).toBe("room-left.txt");
    },
    TEST_TIMEOUT,
  );

  test(
    "a non-ASCII name reaches curl -J as a reversible percent-encoded name",
    async () => {
      const { server, output } = await fixture();
      const filename = "रिपोर्ट😀 test.bin";
      const bytes = payload(4096);
      const channel = await createChannel(server, { filename, contentLength: bytes.length });
      const upload = fetch(channel.uploadUrl, {
        method: "PUT",
        body: bytes,
        headers: { "x-airshare-no-redirect": "1" },
      });
      const receiver = curl(["-f", "-L", "-J", "-O", channel.downloadUrl], output);
      await succeeded(receiver);
      expect((await upload).status).toBe(200);
      const [saved] = await readdir(output);
      expect(saved).toMatch(/^[\x20-\x7e]+$/);
      expect(decodeURIComponent(saved!)).toBe(filename);
      expect(digest(await readFile(join(output, saved!)))).toBe(digest(bytes));
    },
    TEST_TIMEOUT,
  );

  test(
    "103 liveness hints are on by default and off with LIVENESS_HINTS=off",
    async () => {
      for (const [env, expected] of [
        [{}, true],
        [{ LIVENESS_HINTS: "off" }, false],
      ] as const) {
        const { server, input, path } = await fixture(env);
        const source = join(input, "waiting.bin");
        await writeFile(source, payload(64 * 1024));
        const headers = join(path, "waiting.headers");
        const sender = curl(["-T", source, "-L", "-D", headers, `${server.base}/xfr/`], path);
        await discovery(sender, headers, "x-airshare-download-url");
        // The first probe is sent after about a second of waiting.
        await Bun.sleep(2200);
        const hints = (await readHeaders(headers)).filter((block) => block.status === 103);
        expect(hints.length > 0, JSON.stringify(env)).toBe(expected);
        await sender.stop();
      }
    },
    TEST_TIMEOUT,
  );
});

describe("terminal entry points", () => {
  test(
    "only / and /xfr start a terminal receive, and HEAD or an unknown path never creates a channel",
    async () => {
      const { server } = await fixture({ MAX_CHANNELS: "1" });
      for (const agent of [curlAgent, wgetAgent]) {
        for (const path of ["/robots.txt", "/favicon.ico", "/xfrr", "/typo/name.bin", "/.well-known/security.txt"]) {
          const response = await fetch(`${server.base}${path}`, {
            headers: agent,
            redirect: "manual",
            signal: AbortSignal.timeout(3000),
          });
          expect(response.status, path).toBe(404);
          expect(response.headers.get("x-airshare-upload-url"), path).toBeNull();
        }
        for (const path of ["/", "/xfr", "/xfr/name.bin"]) {
          const response = await fetch(`${server.base}${path}`, {
            method: "HEAD",
            headers: agent,
            redirect: "manual",
            signal: AbortSignal.timeout(3000),
          });
          expect(response.status, `HEAD ${path}`).not.toBe(307);
          expect(response.headers.get("x-airshare-upload-url"), `HEAD ${path}`).toBeNull();
        }
      }
      expect((await createChannel(server, { filename: "still-room.txt" })).file.filename).toBe("still-room.txt");
    },
    TEST_TIMEOUT,
  );

  test(
    "a browser can't start a terminal receive with a GET, while curl, Wget and PowerShell can",
    async () => {
      const { server } = await fixture({ MAX_CHANNELS_PER_CLIENT: "4" });
      const get = (path: string, headers: Record<string, string>) =>
        fetch(`${server.base}${path}`, { headers, redirect: "manual", signal: AbortSignal.timeout(3000) });
      const browsers = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0",
      ];
      // Plain HTTP, as on a LAN address: the browser sends no Sec-Fetch-Site.
      for (const agent of browsers)
        for (const path of ["/xfr", "/xfr/name.bin"]) {
          for (const accept of ["image/avif,image/webp,image/apng,image/*,*/*;q=0.8", "*/*"]) {
            const refused = await get(path, { "user-agent": agent, accept });
            expect(refused.status, `${path} ${accept}`).toBe(403);
            expect(await refused.json()).toMatchObject({ reason: "browser_entry" });
          }
          const opened = await get(path, {
            "user-agent": agent,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          });
          expect(opened.status, path).toBe(303);
          expect(opened.headers.get("location")).toBe("/");
        }
      const terminals = [
        "curl/8.16.0",
        "Wget/1.25.0",
        "Mozilla/5.0 (X11; Linux x86_64; en-US) PowerShell/7.5.4",
        "Mozilla/5.0 (Windows NT; Windows NT 10.0; en-US) WindowsPowerShell/5.1.26100.7019",
      ];
      for (const agent of terminals)
        expect((await get("/xfr", { "user-agent": agent, accept: "*/*" })).status, agent).toBe(307);
      // The four terminal receives fill this client's quota exactly, so none of the refused browser GETs made a share.
      expect((await get("/xfr", curlAgent)).status).toBe(429);
    },
    TEST_TIMEOUT,
  );

  test(
    "uploading to a browser page answers 405 with Allow and the transfer link to use",
    async () => {
      const { server } = await fixture();
      const channel = await createChannel(server, { filename: "page.bin", contentLength: 4 });
      const senderKey = new URL(channel.uploadUrl).pathname.split("/")[2]!;
      const receiverKey = new URL(channel.downloadUrl).pathname.split("/")[2]!;
      const cases = [
        [`/s/${senderKey}`, `curl -T <file> ${server.base}/u/${senderKey}/`],
        [`/send/${senderKey}`, `curl -T <file> ${server.base}/u/${senderKey}/`],
        [`/send/${senderKey}/page.bin`, `curl -T <file> ${server.base}/u/${senderKey}/`],
        [`/r/${receiverKey}`, `curl -JLO ${server.base}/l/${receiverKey}`],
        [`/recv/${receiverKey}`, `curl -JLO ${server.base}/l/${receiverKey}`],
      ];
      for (const [path, hint] of cases) {
        for (const method of ["PUT", "POST"]) {
          const response = await fetch(`${server.base}${path}`, {
            method,
            body: "data",
            headers: curlAgent,
            redirect: "manual",
            signal: AbortSignal.timeout(3000),
          });
          expect(response.status, `${method} ${path}`).toBe(405);
          expect(response.headers.get("allow")).toBe("GET, HEAD");
          expect(await response.text()).toContain(hint!);
          expect(response.headers.get("x-airshare-human-info")).toContain(hint!);
        }
      }
      const untouched = await status(senderStatusUrl(channel.uploadUrl));
      expect(untouched.activeUpload).toBeFalsy();
      expect(untouched.completedTransfers).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "a long terminal file name is cut to 255 UTF-8 bytes and keeps its extension",
    async () => {
      const { server } = await fixture();
      for (const [name, expected] of [
        ["M".repeat(600) + ".bin", "M".repeat(251) + ".bin"],
        ["😀".repeat(300) + ".txt", "😀".repeat(62) + ".txt"],
      ] as const) {
        const response = await fetch(`${server.base}/xfr/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: "hello",
          headers: curlAgent,
          redirect: "manual",
          signal: AbortSignal.timeout(3000),
        });
        expect(response.status).toBe(307);
        const uploadUrl = response.headers.get("x-airshare-upload-url")!;
        const current = await status(senderStatusUrl(uploadUrl));
        expect(current.file.filename).toBe(expected);
        expect(new TextEncoder().encode(current.file.filename).length).toBeLessThanOrEqual(255);
        expect(
          decodeURIComponent(new URL(response.headers.get("x-airshare-download-url")!).pathname.split("/").at(-1)!),
        ).toBe(expected);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "wget --post-file to the bare host gets a timestamped default name",
    async () => {
      const { server } = await fixture();
      const before = Date.now();
      const response = await fetch(`${server.base}/`, {
        method: "POST",
        body: "hello",
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
        headers: { ...wgetAgent, "content-type": "application/x-www-form-urlencoded" },
      });
      expect(response.status).toBe(307);
      const current = await status(senderStatusUrl(response.headers.get("x-airshare-upload-url")!));
      const stamp = current.file.filename.match(/^airshare-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.bin$/);
      expect(stamp, current.file.filename).not.toBeNull();
      const [, year, month, day, hour, minute, second] = stamp!.map(Number);
      const named = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
      expect(Math.abs(named - before)).toBeLessThan(5000);
      expect(current.file.contentType).toBe("application/octet-stream");
    },
    TEST_TIMEOUT,
  );
});

describe("terminal names, hints and hashes (Phase 3 review fixes)", () => {
  const putName = async (server: RunningServer, path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${server.base}${path}`, {
      method: "PUT",
      body: "hello",
      headers: { ...curlAgent, ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    expect(response.status, path).toBe(307);
    return (await status(senderStatusUrl(response.headers.get("x-airshare-upload-url")!))).file.filename as string;
  };

  test(
    "only a leading /xfr segment is the entry, so names that start with xfr keep it",
    async () => {
      const { server } = await fixture();
      for (const name of ["xfr_log.txt", "xfr.tar.gz", "xfrm.conf", "xfr"]) {
        expect(await putName(server, `/${name === "xfr" ? "xfr/xfr" : name}`)).toBe(name);
      }
      expect(await putName(server, "/xfr/inner.bin")).toBe("inner.bin");
      expect(await putName(server, "/xfr")).toMatch(/^airshare-\d{8}-\d{6}\.bin$/);
    },
    TEST_TIMEOUT,
  );

  test(
    "names over 255 UTF-8 bytes are shortened after taking the last path segment, on whole graphemes",
    async () => {
      const { server } = await fixture();
      const fromHeader = (name: string) =>
        putName(server, "/xfr/", { "x-airshare-filename": `UTF-8''${encodeURIComponent(name)}` });
      const cases: [string, string][] = [
        ["A".repeat(296) + ".txt", "A".repeat(251) + ".txt"],
        ["x".repeat(600) + "/report.pdf", "report.pdf"],
        ["report/" + "y".repeat(600), "y".repeat(255)],
        ["x".repeat(600) + "\\" + "z".repeat(10) + ".bin", "z".repeat(10) + ".bin"],
        ["e\u0301".repeat(100) + ".txt", "e\u0301".repeat(83) + ".txt"],
        ["a" + "\u0301".repeat(150) + ".txt", "airshare-download"],
      ];
      for (const [name, expected] of cases) {
        const stored = await fromHeader(name);
        expect(stored, name.slice(0, 40)).toBe(expected);
        expect(new TextEncoder().encode(stored).length).toBeLessThanOrEqual(255);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "the ASCII filename= fallback is at most 255 characters, so curl -J can save a long name",
    async () => {
      const { server, output } = await fixture();
      for (const filename of ["A".repeat(296) + ".txt", "é".repeat(200) + ".txt"]) {
        const channel = await createChannel(server, { filename, contentLength: 5 });
        const upload = fetch(channel.uploadUrl, {
          method: "PUT",
          body: "hello",
          headers: { "x-airshare-no-redirect": "1" },
        });
        const response = await fetch(channel.downloadUrl, { signal: AbortSignal.timeout(5000) });
        const ascii = response.headers.get("content-disposition")!.match(/filename="([^"]*)"/)![1]!;
        expect(ascii.length).toBeLessThanOrEqual(255);
        expect(ascii.endsWith(".txt")).toBe(true);
        expect(await response.text()).toBe("hello");
        expect((await upload).status).toBe(200);
      }
      // Windows paths would also hit MAX_PATH here, so the real save is checked where paths allow it.
      if (process.platform !== "win32") {
        const channel = await createChannel(server, { filename: "B".repeat(296) + ".txt", contentLength: 5 });
        const upload = fetch(channel.uploadUrl, {
          method: "PUT",
          body: "hello",
          headers: { "x-airshare-no-redirect": "1" },
        });
        await succeeded(curl(["-f", "-L", "-J", "-O", channel.downloadUrl], output));
        expect(await readdir(output)).toContain("B".repeat(251) + ".txt");
        expect((await upload).status).toBe(200);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "the 411 prepare command keeps a quote in the path inside its single-quoted URL",
    async () => {
      const { server, path } = await fixture();
      const piped = curl(["-s", "-T", "-", "-D", "-", `${server.base}/it's.txt`], path, payload(1024));
      const result = await bounded(piped.result, 6000, () => `The unprepared pipe was not answered: ${piped.stderr()}`);
      const hint = result.stdout.split(/\r?\n/).find((line) => line.startsWith("x-airshare-human-info:"))!;
      const quoted = hint.match(/-D \/dev\/stderr '([^']*)'\)/)?.[1];
      expect(quoted).toBe(`${server.base}/it%27s.txt?prepare=1`);
      const prepared = await fetch(quoted!, { method: "POST", signal: AbortSignal.timeout(3000) });
      expect(prepared.status).toBe(201);
      expect((await status(senderStatusUrl((await prepared.text()).trim()))).file.filename).toBe("it's.txt");
    },
    TEST_TIMEOUT,
  );

  test(
    "a file really named airshare-download keeps that name unless a name header says otherwise",
    async () => {
      const { server } = await fixture();
      for (const [headers, expected] of [
        [{}, "airshare-download"],
        [{ "x-airshare-filename": "from-header.txt" }, "from-header.txt"],
      ] as const) {
        const channel = await createChannel(server, { filename: "stored.txt" });
        const placeholderUrl = channel.uploadUrl.replace(/[^/]*$/, "airshare-download");
        const upload = fetch(placeholderUrl, {
          method: "PUT",
          body: "hello",
          headers: { ...headers, "x-airshare-no-redirect": "1" },
        });
        const response = await fetch(channel.downloadUrl, { signal: AbortSignal.timeout(5000) });
        expect(response.headers.get("content-disposition")).toContain(`filename="${expected}"`);
        await response.text();
        expect((await upload).status).toBe(200);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "an upload tracked by a Station-format tracker reports the payload hash; a native tracker's does not",
    async () => {
      const { server } = await fixture();
      const bytes = payload(70_000);
      for (const [format, hashed] of [
        ["", true],
        ["?format=native", false],
      ] as const) {
        const stream = await fetch(`${server.base}/api/v1/track${format}`, { signal: AbortSignal.timeout(10_000) });
        const events = sseReader(stream);
        const trackerKey = (await events.next("tracker_event")).data.initialized.tracker_key as string;
        const channel = await createChannel(server, { filename: "tracked.bin", contentLength: bytes.length });
        const downloading = fetch(channel.downloadUrl, { signal: AbortSignal.timeout(5000) }).then((response) =>
          response.arrayBuffer(),
        );
        await until(
          () => status(senderStatusUrl(channel.uploadUrl)),
          (value) => value.waitingReceivers === 1,
        );
        // Redirect mode, as curl uses: no no-redirect header.
        const upload = await fetch(channel.uploadUrl, {
          method: "PUT",
          body: bytes,
          redirect: "manual",
          headers: { "com.station307.tracker": trackerKey },
          signal: AbortSignal.timeout(5000),
        });
        expect(upload.status).toBe(307);
        expect(digest(new Uint8Array(await downloading))).toBe(digest(bytes));
        let event;
        do event = await events.next("transfer_event");
        while (!event.data.succeeded || event.data.succeeded.bytes_sent === undefined);
        expect(event.data.succeeded.hash, format || "station").toBe(hashed ? digest(bytes) : undefined);
        await events.cancel();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "x-airshare-filename accepts raw UTF-8 and the UTF-8'' percent-encoded form, and still strips control and bidi characters",
    async () => {
      const { server } = await fixture();
      const latin1 = (text: string) => Buffer.from(text, "utf8").toString("latin1");
      const cases: [string, string][] = [
        [latin1("café.txt"), "café.txt"],
        ["UTF-8''caf%C3%A9.txt", "café.txt"],
        ["utf-8''%E0%A4%B0%E0%A4%BF.pdf", "रि.pdf"],
        ["caf\u00e9.txt", "café.txt"],
        ["UTF-8''%E2%80%AEevil%07.txt", "_evil_.txt"],
        [latin1("\u202Egnp.exe"), "_gnp.exe"],
      ];
      for (const [header, expected] of cases)
        expect(await putName(server, "/xfr/", { "x-airshare-filename": header }), header).toBe(expected);
    },
    TEST_TIMEOUT,
  );
});
