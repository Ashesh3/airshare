import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const base = Bun.env.AIRSHARE_PROXY_TEST_URL;
assert(base, "Run this check using compose.smoke.yaml, or set AIRSHARE_PROXY_TEST_URL.");
const directory = await mkdtemp(join(tmpdir(), "airshare-proxy-smoke-"));
const clients = new Set<ReturnType<typeof Bun.spawn>>();
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function curl(args: string[], input?: Uint8Array) {
  const child = Bun.spawn(
    ["curl", "--silent", "--show-error", "--noproxy", "*", "--connect-timeout", "3", "--max-time", "20", ...args],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  clients.add(child);
  const output = new Response(child.stdout).text();
  const error = new Response(child.stderr).text();
  const written = (async () => {
    if (input) child.stdin.write(input);
    await child.stdin.end();
  })().catch(() => {});
  return {
    async done() {
      const [code, stdout, stderr] = await Promise.all([child.exited, output, error, written]);
      assert.equal(code, 0, `curl failed (${code}): ${stderr}`);
      clients.delete(child);
      return stdout;
    },
  };
}
function header(text: string, name: string) {
  const value = text.match(new RegExp(`^${name}:\\s*(\\S+)`, "mi"))?.[1];
  assert(value, `Missing ${name}`);
  return value;
}
async function receive(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200);
  return { bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
}

try {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {}
    assert(Date.now() < deadline, "Proxy did not become healthy");
    await Bun.sleep(100);
  }

  // 340 Devanagari characters plus '.bin' is the longest name a channel accepts, 1024 UTF-8 bytes, so the request and
  // redirect lines through nginx are as long as they get. A terminal upload keeps 255 bytes of it: 83 whole characters.
  const name = "र".repeat(340) + ".bin";
  const stored = "र".repeat(83) + ".bin";
  const payload = randomBytes(2 * 1024 * 1024 + 19);
  const source = join(directory, "source.bin");
  const initialHeaders = join(directory, "initial.headers");
  await Bun.write(source, payload);
  await curl(["-T", source, "-D", initialHeaders, "-o", "/dev/null", `${base}/xfr/${encodeURIComponent(name)}`]).done();
  const initial = await Bun.file(initialHeaders).text();
  assert.match(initial, /^HTTP\/\S+ 307/m);
  const uploadUrl = header(initial, "x-airshare-upload-url");
  const downloadUrl = header(initial, "x-airshare-download-url");
  assert.equal(header(initial, "com.station307.human.transfer.url"), downloadUrl);
  const receiving = receive(downloadUrl);
  void receiving.catch(() => {});
  const uploading = curl(["--fail", "-H", "x-airshare-no-redirect: 1", "-T", source, uploadUrl]).done();
  const [received] = await Promise.all([receiving, uploading]);
  assert.equal(received.bytes.length, payload.length);
  assert.equal(digest(received.bytes), digest(payload));
  assert(
    received.headers.get("content-disposition")?.includes(encodeURIComponent(stored)),
    received.headers.get("content-disposition") ?? "no Content-Disposition",
  );

  // A preparation response has the same large URL headers. Its empty request
  // must not advertise a zero-byte file or redirect a non-rewindable stdin body.
  const preparedHeaders = join(directory, "prepared.headers");
  const senderUrl = (
    await curl([
      "--fail",
      "-X",
      "POST",
      "-H",
      "content-length: 0",
      "-D",
      preparedHeaders,
      `${base}/xfr/${encodeURIComponent(name)}?prepare=1`,
    ]).done()
  ).trim();
  const prepared = await Bun.file(preparedHeaders).text();
  assert.match(prepared, /^HTTP\/\S+ 201/m);
  const pipePayload = randomBytes(3 * 1024 * 1024 + 17);
  const pipeReceiving = receive(header(prepared, "x-airshare-download-url"));
  void pipeReceiving.catch(() => {});
  const pipeUploading = curl(["--fail", "-T", "-", senderUrl], pipePayload).done();
  const [pipeReceived] = await Promise.all([pipeReceiving, pipeUploading]);
  assert.equal(pipeReceived.bytes.length, pipePayload.length);
  assert.equal(digest(pipeReceived.bytes), digest(pipePayload));
  console.log(
    JSON.stringify(
      {
        longDomain: new URL(base).hostname,
        filenameUtf8Bytes: Buffer.byteLength(name),
        redirectHeaderBytes: Buffer.byteLength(initial),
        cli: { status: 307, bytes: received.bytes.length, integrity: true },
        preparedStdin: { status: 201, bytes: pipeReceived.bytes.length, integrity: true },
      },
      null,
      2,
    ),
  );
} finally {
  for (const child of clients) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  await rm(directory, { recursive: true, force: true });
}
