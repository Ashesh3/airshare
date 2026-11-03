import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChannel, startServer, temporaryDataDir, until, type RunningServer } from "./server-helper";

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
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message())), timeout); }),
    ]);
  } finally { clearTimeout(timer!); }
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
  const child = Bun.spawn([
    curlExecutable!, "-q", "--silent", "--show-error", "--noproxy", "*",
    "--connect-timeout", "3", "--max-time", "15", ...args,
  ], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
    drain(child.stdout, (value) => { stdout = (stdout + value).slice(-64 * 1024); }),
    drain(child.stderr, (value) => { stderr = (stderr + value).slice(-64 * 1024); }),
  ];
  if (input) child.stdin.write(input);
  // Feed stdin immediately, before the initial redirect. Waiting for the redirect
  // first would conceal a server that consumes non-rewindable input too early.
  const inputClosed = Promise.resolve(child.stdin.end()).catch((error) => { stderr += `\nstdin: ${String(error)}`; });
  const result = child.exited.then(async (code) => {
    await Promise.all([...drains, inputClosed]);
    return { code, stdout, stderr };
  });
  const process: CurlProcess = {
    child, result, stderr: () => stderr,
    async stop() {
      if (child.exitCode === null) { try { child.kill(); } catch {} }
      try {
        await bounded(child.exited, 2000, () => "curl did not terminate");
      } catch {
        try { child.kill("SIGKILL"); } catch {}
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
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const fragments = text.split(/\r?\n\r?\n/);
  fragments.pop(); // A partial final block is not safe for link discovery yet.
  return fragments.flatMap((fragment) => {
    const lines = fragment.split(/\r?\n/);
    const status = lines.shift()?.match(/^HTTP\/\S+ (\d{3})/);
    if (!status) return [];
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    return [{ status: Number(status[1]), headers }];
  });
}

async function discovery(process: CurlProcess, path: string, header: string) {
  const block = await until(async () => {
    const found = (await readHeaders(path)).find((candidate) => candidate.status === 307 && candidate.headers[header]);
    if (found) return found;
    if (process.child.exitCode !== null) {
      const ended = await process.result;
      throw new Error(`curl exited before publishing ${header}: ${ended.code} ${ended.stderr}`);
    }
    return undefined;
  }, (value) => value !== undefined, 5000);
  return block!;
}

function senderStatusUrl(uploadUrl: string) {
  const url = new URL(uploadUrl);
  url.pathname = url.pathname.replace(/\/upload(?:\/.*)?$/, "");
  return url.href;
}

async function status(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error(`Channel status returned HTTP ${response.status}`);
  return response.json();
}

function digest(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function payload(size: number) { return Uint8Array.from({ length: size }, (_, index) => (index * 37 + 19) & 255); }

describe("real curl workflows", () => {
  test("regular-file hosting discovers its basename and serves two complete sequential downloads until cancelled", async () => {
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
    const current = await until(() => status(senderStatusUrl(uploadUrl)), (value) => value.activeUpload);
    expect(current.file.filename).toBe(filename);
    expect(current.file.contentLength).toBe(bytes.length);
    expect(Object.entries(initial.headers).some(([name, value]) => name.startsWith("x-airshare-human-qr-") && /[█▀▄]/.test(value))).toBe(true);

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
      await until(() => status(senderStatusUrl(uploadUrl)), (value) => value.completedTransfers === index && value.activeUpload);
      expect(sender.child.exitCode).toBeNull();
    }
    expect((await readHeaders(headers)).filter((block) => block.status === 307).length).toBeGreaterThanOrEqual(3);
    await sender.stop();
    const stopped = await until(() => status(senderStatusUrl(uploadUrl)), (value) => !value.activeUpload && !value.senderOnline);
    expect(stopped.completedTransfers).toBe(2);
    expect(stopped.waitingReceivers).toBe(0);
    expect(stopped.activeReceivers).toBe(0);
  }, TEST_TIMEOUT);

  test("a large body sent without Expect can follow the early creation redirect and deliver intact", async () => {
    const { server, input, output, path } = await fixture();
    const bytes = payload(2 * 1024 * 1024 + 53);
    const source = join(input, "immediate.bin");
    const headers = join(path, "immediate-sender.headers");
    await writeFile(source, bytes);
    const sender = curl(["-H", "Expect:", "-T", source, "-L", "--max-redirs", "-1", "-D", headers, `${server.base}/xfr/`], path);
    const initial = await discovery(sender, headers, "x-airshare-download-url");
    const destination = join(output, "immediate.bin");
    const receiver = curl(["-f", "-L", "-o", destination, initial.headers["x-airshare-download-url"]!], output);
    await succeeded(receiver);
    expect(digest(await readFile(destination))).toBe(digest(bytes));
    const url = senderStatusUrl(initial.headers["x-airshare-upload-url"]!);
    await until(() => status(url), (value) => value.completedTransfers === 1 && value.activeUpload);
    expect(sender.child.exitCode).toBeNull();
  }, TEST_TIMEOUT);

  test("receiver cancellation leaves a regular sender hosting the complete file for a later receiver", async () => {
    const { server, input, output, path } = await fixture();
    const bytes = payload(8 * 1024 * 1024 + 73);
    const source = join(input, "after-cancellation.bin");
    const headers = join(path, "recovery-sender.headers");
    await writeFile(source, bytes);
    // Bound the sender's rate so the first receiver can cancel after real bytes
    // arrive, before loopback buffers could contain the whole synthetic file.
    const sender = curl(["--limit-rate", "4M", "-T", source, "-L", "--max-redirs", "-1", "-D", headers, `${server.base}/xfr/`], path);
    const initial = await discovery(sender, headers, "x-airshare-download-url");
    const downloadUrl = initial.headers["x-airshare-download-url"]!;
    const channelUrl = senderStatusUrl(initial.headers["x-airshare-upload-url"]!);
    const abort = new AbortController();
    try {
      const response = await fetch(downloadUrl, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = await bounded(reader.read(), 3000, () => "First receiver did not receive any bytes");
      expect(first.value!.byteLength).toBeGreaterThan(0);
      expect(first.value!.byteLength).toBeLessThan(bytes.length);
      abort.abort();
      await reader.cancel().catch(() => {});
    } finally { abort.abort(); }

    await until(async () => {
      if (sender.child.exitCode !== null) {
        const ended = await sender.result;
        throw new Error(`curl stopped hosting after receiver cancellation: ${ended.code}\n${ended.stderr}\n${ended.stdout}`);
      }
      return status(channelUrl);
    }, (value) => value.activeUpload && value.activeReceivers === 0 && value.bytesTransferred === 0, 5000);
    const destination = join(output, "complete-after-cancellation.bin");
    const receiver = curl(["-f", "-L", "-o", destination, downloadUrl], output);
    await succeeded(receiver);
    const received = await readFile(destination);
    expect(received.byteLength).toBe(bytes.length);
    expect(digest(received)).toBe(digest(bytes));
    await until(() => status(channelUrl), (value) => value.activeUpload && value.completedTransfers === 1);
    expect(sender.child.exitCode).toBeNull();
    await sender.stop();
    const stopped = await until(() => status(channelUrl), (value) => !value.activeUpload && !value.senderOnline);
    expect(stopped.completedTransfers).toBe(1);
    expect(stopped.waitingReceivers).toBe(0);
    expect(stopped.activeReceivers).toBe(0);
  }, TEST_TIMEOUT);

  test("receiver-first -f -L -J -O uses the sender's eventual filename, content type and size", async () => {
    const { server, input, output, path } = await fixture();
    const receiveHeaders = join(path, "receiver.headers");
    const receiver = curl(["-f", "-L", "-J", "-O", "-D", receiveHeaders, `${server.base}/xfr`], output);
    const initial = await discovery(receiver, receiveHeaders, "x-airshare-upload-url");
    const uploadUrl = initial.headers["x-airshare-upload-url"]!;
    await until(() => status(senderStatusUrl(uploadUrl)), (value) => value.waitingReceivers === 1);
    expect(await readdir(output)).toEqual([]);
    const filename = "quarterly report.csv";
    const bytes = new TextEncoder().encode("name,value\r\nalpha,42\r\nbeta,17\r\n");
    const source = join(input, filename);
    await writeFile(source, bytes);
    // A trailing slash lets curl append the source basename to the sender URL.
    const target = new URL(uploadUrl);
    target.pathname = target.pathname.replace(/\/[^/]*$/, "/");
    const sender = curl(["-T", source, "-H", "content-type: text/csv", "-H", "x-airshare-no-redirect: 1", target.href], path);
    await Promise.all([succeeded(sender), succeeded(receiver)]);
    expect(await readdir(output)).toEqual([filename]);
    expect(digest(await readFile(join(output, filename)))).toBe(digest(bytes));
    const final = (await readHeaders(receiveHeaders)).findLast((block) => block.status === 200)!;
    expect(final.headers["content-disposition"]).toContain(filename);
    expect(final.headers["content-type"]).toBe("text/csv");
    expect(final.headers["content-length"]).toBe(String(bytes.length));
    expect((await status(senderStatusUrl(uploadUrl))).completedTransfers).toBe(1);
  }, TEST_TIMEOUT);

  test("prepared piped stdin sends its complete unknown-length payload directly and exits after one receiver", async () => {
    const { server, output, path } = await fixture();
    const bytes = payload(3 * 1024 * 1024 + 17);
    const prepareHeaders = join(path, "prepare.headers");
    const preparation = curl(["-f", "-X", "POST", "-H", "content-length: 0", "-D", prepareHeaders, `${server.base}/xfr/log.txt?prepare=1`], path);
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
    const active = await until(() => status(senderStatusUrl(uploadUrl)), (value) => value.activeUpload);
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
    const completed = await until(() => status(senderStatusUrl(uploadUrl)), (value) => !value.activeUpload);
    expect(completed.completedTransfers).toBe(1);
    expect(completed.senderOnline).toBe(false);
  }, TEST_TIMEOUT);

  test("unprepared unknown-length creation is rejected without a redirect or an allocated share", async () => {
    const { server, path } = await fixture({ MAX_CHANNELS: "1" });
    for (const method of ["PUT", "POST"]) {
      const headers = join(path, `unprepared-${method}.headers`);
      const sender = curl(["--fail-with-body", "-X", method, "-T", "-", "-D", headers, `${server.base}/xfr/unprepared.txt`], path, payload(64 * 1024 + 7));
      const result = await bounded(sender.result, 6000, () => `Unprepared stdin was not rejected: ${sender.stderr()}`);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("prepare=1");
      const blocks = (await readHeaders(headers)).filter((block) => block.status >= 200);
      expect(blocks.map((block) => block.status)).toEqual([411]);
      expect(blocks[0]!.headers["location"]).toBeUndefined();
      expect(blocks[0]!.headers["x-airshare-upload-url"]).toBeUndefined();
      expect(blocks[0]!.headers["x-airshare-download-url"]).toBeUndefined();
    }
    expect((await createChannel(server, { filename: "no-rejected-input-leak.txt" })).file.filename).toBe("no-rejected-input-leak.txt");
  }, TEST_TIMEOUT);

  test("a zero-byte CLI file downloads with Content-Length zero and remains available to the next receiver", async () => {
    const { server, input, output, path } = await fixture();
    const source = join(input, "empty.bin");
    await writeFile(source, new Uint8Array());
    const headers = join(path, "empty-sender.headers");
    const sender = curl(["-T", source, "-L", "--max-redirs", "-1", "-D", headers, `${server.base}/xfr/`], path);
    const initial = await discovery(sender, headers, "x-airshare-download-url");
    for (let index = 1; index <= 2; index += 1) {
      const destination = join(output, `empty-${index}.bin`);
      const receiverHeaders = join(path, `empty-receiver-${index}.headers`);
      const receiver = curl(["-f", "-L", "-D", receiverHeaders, "-o", destination, initial.headers["x-airshare-download-url"]!], output);
      await succeeded(receiver);
      expect((await readFile(destination)).byteLength).toBe(0);
      const final = (await readHeaders(receiverHeaders)).findLast((block) => block.status === 200)!;
      expect(final.headers["content-length"]).toBe("0");
      expect(final.headers["content-disposition"]).toContain("empty.bin");
      await until(() => status(senderStatusUrl(initial.headers["x-airshare-upload-url"]!)), (value) => value.activeUpload && value.completedTransfers === index);
      expect(sender.child.exitCode).toBeNull();
    }
  }, TEST_TIMEOUT);

  test("cancelling a sender waiting for its first receiver releases presence and lets its idle channel expire", async () => {
    const { server, input, path } = await fixture({ MAX_CHANNELS: "1", CHANNEL_TTL_MS: "250", CLEANUP_INTERVAL_MS: "25" });
    const source = join(input, "cancel.bin");
    await writeFile(source, payload(8192));
    const headers = join(path, "cancel.headers");
    const sender = curl(["-T", source, "-L", "--max-redirs", "-1", "-D", headers, `${server.base}/xfr/`], path);
    const initial = await discovery(sender, headers, "x-airshare-upload-url");
    const url = senderStatusUrl(initial.headers["x-airshare-upload-url"]!);
    await until(() => status(url), (value) => value.activeUpload && value.senderOnline);
    await sender.stop();
    const stopped = await until(() => status(url), (value) => !value.activeUpload && !value.senderOnline);
    expect(stopped.completedTransfers).toBe(0);
    expect(stopped.waitingReceivers).toBe(0);
    expect(stopped.activeReceivers).toBe(0);
    // Stop reading status while waiting: channel activity may refresh its TTL.
    await Bun.sleep(550);
    expect((await fetch(url, { signal: AbortSignal.timeout(2500) })).status).toBe(404);
    expect((await createChannel(server, { filename: "capacity-reclaimed.txt" })).file.filename).toBe("capacity-reclaimed.txt");
  }, TEST_TIMEOUT);
});
