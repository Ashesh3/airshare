/// <reference lib="dom" />
import { test as base, expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { get as httpGet } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SyntheticFile } from "./ui";

export { expect };
export const HOST_GRACE_MS = 2000;
// The server's default presence lease, which the suite leaves unchanged. A page renews it only while its
// status stream is down, with one POST /api/presence every 4 s; an open stream alone keeps its shares hosted.
export const SENDER_LEASE_MS = 10_000;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * restart() relaunches on the same port and data directory after downtimeMs; settings it overrides last
 * until the next restart.
 */
export type RestartOptions = { settings?: Record<string, string>; downtimeMs?: number };
export type AirShareServer = {
  base: string;
  logs: () => string;
  exited: () => string | undefined;
  restart: (options?: RestartOptions) => Promise<void>;
};

type Launched = { child: ReturnType<typeof spawn>; base: string };

async function launch(
  dataDir: string,
  port: string,
  log: (text: string) => void,
  settings: Record<string, string> = {},
): Promise<Launched> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: port,
    DATA_DIR: dataDir,
    NODE_ENV: "production",
    HOST_GRACE_MS: String(HOST_GRACE_MS),
    // Every test client shares 127.0.0.1, so the per-client creation limiter would throttle the suite.
    CHANNEL_CREATION_BURST: "0",
    ...settings,
  };
  delete env.PUBLIC_URL;
  delete env.SENDER_LEASE_MS;
  // AIRSHARE_E2E_PRELOAD instruments the server process when diagnosing a failure.
  const preload = process.env.AIRSHARE_E2E_PRELOAD ? ["--preload", process.env.AIRSHARE_E2E_PRELOAD] : [];
  const child = spawn(process.env.AIRSHARE_E2E_BUN ?? "bun", [...preload, "src/server.ts"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`AirShare did not start: ${output}`)), 15_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      log(chunk.toString());
      const listening = output.match(/AirShare listening on http:\/\/[^:\s]+:(\d+)/)?.[1];
      if (listening) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${listening}`);
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`AirShare exited (${code}): ${output}`));
    });
  });
  return { child, base };
}

async function terminate(child: ReturnType<typeof spawn>) {
  // A child killed by a signal keeps exitCode null, so both fields say whether it is still running.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  // A graceful shutdown that hangs is reported, then forced, so it cannot stall the whole run.
  const force = setTimeout(() => {
    console.warn("AirShare did not exit within 10 s of SIGTERM; killing it.");
    child.kill("SIGKILL");
  }, 10_000);
  await exited;
  clearTimeout(force);
}

async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), "airshare-e2e-"));
  let output = "";
  const log = (text: string) => {
    output += text;
  };
  let current = await launch(dataDir, "0", log);
  let exitedWith: string | undefined;
  const watch = (launched: Launched) =>
    launched.child.once("exit", (code, signal) => {
      if (current === launched) exitedWith = `code ${code}, signal ${signal}`;
    });
  watch(current);
  const base = current.base;
  // Restarts the relay on the same port and data directory, as an operator restarting it would.
  const restart = async ({ settings = {}, downtimeMs = 0 }: RestartOptions = {}) => {
    const previous = current;
    current = { child: previous.child, base };
    await terminate(previous.child);
    await new Promise((resolve) => setTimeout(resolve, downtimeMs));
    current = await launch(dataDir, new URL(base).port, log, settings);
    watch(current);
  };
  const stop = async () => {
    await terminate(current.child);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { server: { base, logs: () => output, exited: () => exitedWith, restart }, stop };
}

export type PageIssues = { consoleErrors: string[]; pageErrors: string[]; cspViolations: string[] };

export const test = base.extend<{ issues: PageIssues; serverAlive: void }, { airshare: AirShareServer }>({
  airshare: [
    async ({}, use) => {
      const { server, stop } = await startServer();
      try {
        await use(server);
      } finally {
        await stop();
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ airshare }, use) => {
    await use(airshare.base);
  },
  // Whatever a browser does, the relay process must survive it.
  serverAlive: [
    async ({ airshare }, use, testInfo) => {
      await use();
      if (testInfo.status !== testInfo.expectedStatus) {
        // A server that is dying when a test fails needs a moment to report its exit and last output.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await testInfo.attach("airshare-server.log", { body: airshare.logs(), contentType: "text/plain" });
      }
      const exited = airshare.exited();
      if (exited)
        throw new Error(`The AirShare server exited during the test (${exited}). Output:\n${airshare.logs()}`);
    },
    { auto: true },
  ],
  // Collected for every page in the test's context; only tests that assert on it fail.
  issues: async ({ context }, use) => {
    const issues: PageIssues = { consoleErrors: [], pageErrors: [], cspViolations: [] };
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        console.error(`CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || "inline"}`);
      });
    });
    const watch = (page: Page) => {
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        // A 404 page's own document load is logged by Chromium; that status is intended.
        if (/status of 404/.test(message.text()) && message.location().url === page.url()) return;
        const line = `${page.url()} :: ${message.text()}`;
        if (/Content Security Policy|CSP violation/i.test(message.text())) issues.cspViolations.push(line);
        else issues.consoleErrors.push(line);
      });
      page.on("pageerror", (error) => issues.pageErrors.push(`${page.url()} :: ${error.message}`));
    };
    context.pages().forEach(watch);
    context.on("page", watch);
    await use(issues);
  },
});

export function syntheticFile(name: string, size = 64 * 1024, mimeType = "application/octet-stream"): SyntheticFile {
  const buffer = randomBytes(size);
  return { name, mimeType, buffer, sha256: sha256(buffer) };
}

export function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

export type HttpDownload = {
  status: number;
  failure?: string;
  sha256: string;
  bytes: number;
  elapsedMs: number;
  headers: Headers;
  json?: { error?: string; reason?: string };
  /** The connection failed before any response headers arrived. */
  failedBeforeHeaders?: boolean;
  /** Why a first attempt was retried. */
  retried?: string;
};

/**
 * A plain HTTP receiver, like curl without -f. Each call opens its own connection: a reused
 * keep-alive socket that the server is closing would look like a dropped receiver.
 *
 * `retryBeforeHeaders` retries once when the connection fails before any response headers, as a person
 * would rerun curl. On Windows the test's own client occasionally sees a reset that never passed through
 * the server (a TCP relay in between saw none), so this one failure says nothing about the relay.
 */
export async function httpDownload(
  url: string,
  timeoutMs = 10_000,
  { retryBeforeHeaders = false } = {},
): Promise<HttpDownload> {
  const first = await downloadOnce(url, timeoutMs);
  if (!retryBeforeHeaders || !first.failedBeforeHeaders) return first;
  // An immediate retry can be refused by the same client-side fault, so it waits a moment.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const second = await downloadOnce(url, timeoutMs);
  return { ...second, elapsedMs: first.elapsedMs + 500 + second.elapsedMs, retried: first.failure };
}

function downloadOnce(url: string, timeoutMs: number): Promise<HttpDownload> {
  const started = Date.now();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let status = 0;
    let declared = "?";
    let settled = false;
    const finish = (result: Omit<HttpDownload, "elapsedMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, elapsedMs: Date.now() - started });
    };
    // Status 0 makes a hung or dropped receiver read as a failed expectation instead of a stack trace.
    const failed = (what: string, beforeHeaders = false) => {
      const progress = status ? ` after HTTP ${status} and ${Buffer.concat(chunks).length} of ${declared} bytes` : "";
      finish({
        status: 0,
        failure: `${what}${progress}`,
        sha256: "",
        bytes: 0,
        headers: new Headers(),
        failedBeforeHeaders: beforeHeaders && !status,
      });
    };
    const request = httpGet(url, { agent: false }, (response) => {
      status = response.statusCode ?? 0;
      declared = response.headers["content-length"] ?? "?";
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", (error) => failed(`the receiver connection failed: ${error.message}`));
      response.on("end", () => {
        if (!response.complete) return failed("the receiver connection was cut");
        const data = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (typeof value === "string") headers.set(name, value);
        let json: HttpDownload["json"];
        if (status >= 400) {
          try {
            json = JSON.parse(data.toString("utf8"));
          } catch {}
        }
        finish({ status, sha256: sha256(data), bytes: data.length, json, headers });
      });
    });
    request.on("error", (error) => failed(`the receiver connection failed: ${error.message}`, true));
    const timer = setTimeout(() => {
      failed("the receiver hung");
      request.destroy();
    }, timeoutMs);
  });
}

/** The real curl binary, as in the contract's "a curl download succeeds". */
export async function curlDownload(url: string, outDir: string, maxTimeSeconds = 10, extraArgs: string[] = []) {
  const file = join(outDir, `curl-${randomBytes(6).toString("hex")}.bin`);
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(
      curl,
      ["-sS", "-f", "-L", "--max-time", String(maxTimeSeconds), ...extraArgs, "-o", file, url],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  const sha = code === 0 ? sha256(await readFile(file)) : undefined;
  return { exitCode: code, sha256: sha, stderr: stderr.trim() };
}

/** Kills the renderer without running pagehide/unload, like a crashed or force-killed tab. */
export async function crashPage(page: Page) {
  // Page.crash needs the Chrome DevTools Protocol, which only Chromium offers.
  test.skip(
    page.context().browser()?.browserType().name() !== "chromium",
    "crashing a tab needs Chromium's DevTools protocol",
  );
  const session = await page.context().newCDPSession(page);
  const crashed = page.waitForEvent("crash", { timeout: 15_000 });
  // The command never gets a reply from a renderer that crashed, so don't wait for one.
  void session.send("Page.crash").catch(() => {});
  await crashed;
}

/** Makes the page report itself hidden, as a background tab does; headless Chromium never hides pages itself. */
export async function hidePage(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/**
 * Delays page timers to once a minute, like Chrome's intensive throttling of long-hidden tabs.
 * Headless Chromium neither hides nor freezes pages, so the page's own timers are wrapped instead.
 */
export async function throttleTimers(page: Page) {
  await page.evaluate(() => {
    const minute = 60_000;
    const setTimeoutNative = window.setTimeout.bind(window);
    const setIntervalNative = window.setInterval.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
      setTimeoutNative(handler, Math.max(delay ?? 0, minute), ...args)) as typeof window.setTimeout;
    window.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
      setIntervalNative(handler, Math.max(delay ?? 0, minute), ...args)) as typeof window.setInterval;
  });
}

/** A receiver-first request created from the terminal entry point, before anyone downloads. */
export async function createReceiveRequest(base: string) {
  const response = await fetch(`${base}/xfr`, { redirect: "manual", headers: { "user-agent": "curl/8.0.0" } });
  expect(response.status, "terminal receive entry answers with a redirect").toBe(307);
  const sendPageUrl = response.headers.get("com.station307.human.web.url");
  const location = response.headers.get("location");
  if (!sendPageUrl || !location) throw new Error("receive entry did not print the send page and download URLs");
  return { sendPageUrl, downloadUrl: new URL(location, base).href };
}

/** A plain API channel with no sender attached. */
export async function createApiChannel(base: string, filename = "api-file.bin", contentLength = 16) {
  const response = await fetch(`${base}/api/channels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename, contentType: "application/octet-stream", contentLength }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<Record<string, any>>;
}
