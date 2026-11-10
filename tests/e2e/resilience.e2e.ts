import { readFile } from "node:fs/promises";
import {
  test,
  expect,
  HOST_GRACE_MS,
  SENDER_LEASE_MS,
  syntheticFile,
  httpDownload,
  hidePage,
  throttleTimers,
  curlDownload,
  sha256,
} from "./fixtures";
import {
  ui,
  addFiles,
  shareItem,
  shareDownloadUrl,
  shareHumanUrl,
  navLink,
  downloadControl,
  expectDownloadEnabled,
} from "./ui";

// Review follow-ups: a share must not end while its tab is alive but in the background or briefly offline.
const outlastHostTimers = HOST_GRACE_MS + SENDER_LEASE_MS + 2000;

test.describe("shares in a background tab", () => {
  for (const mode of ["hidden", "hidden with timers throttled to once a minute"] as const) {
    test(`five shares stay live while the tab is ${mode}`, async ({ page }) => {
      const files = Array.from({ length: 5 }, (_, index) =>
        syntheticFile(`background-${mode === "hidden" ? "hidden" : "throttled"}-${index + 1}.bin`, 64 * 1024),
      );
      await page.goto("/");
      await addFiles(page, files);
      const urls = [];
      for (const file of files) urls.push(await shareDownloadUrl(page, file.name));
      await hidePage(page);
      if (mode !== "hidden") await throttleTimers(page);
      await page.waitForTimeout(outlastHostTimers);
      for (const [index, file] of files.entries()) {
        const download = await httpDownload(urls[index]!);
        expect(download.status, download.failure ?? `${file.name}: ${JSON.stringify(download.json)}`).toBe(200);
        expect(download.sha256, file.name).toBe(file.sha256);
      }
    });
  }
});

// The page's one status stream is GET /api/v1/track?format=native.
const TRACKER = /\/api\/v1\/track(\?|$)/;
const isPresence = (method: string, url: string) => method === "POST" && new URL(url).pathname === "/api/presence";

for (const failures of [1, 3]) {
  const title = failures === 1 ? "its status stream failing" : `${failures} status stream failures in a row`;
  test(`a share survives ${title}, and the page reopens the stream`, async ({ page }) => {
    const streams: number[] = [];
    const presence: number[] = [];
    await page.route(TRACKER, async (route) => {
      streams.push(Date.now());
      if (streams.length > failures) return route.continue();
      // A non-200 answer makes EventSource give up for good instead of retrying by itself.
      await route.fulfill({ status: 502, contentType: "text/plain", body: "Bad gateway" });
    });
    page.on("request", (request) => {
      if (isPresence(request.method(), request.url())) presence.push(Date.now());
    });
    await page.goto("/");
    const file = syntheticFile(`dead-stream-${failures}.bin`, 64 * 1024);
    await addFiles(page, [file]);
    const url = await shareDownloadUrl(page, file.name);
    // Retries back off from 1 s (1 + 2 + 4 s for three failures).
    await expect
      .poll(() => streams.length, {
        message: "the page reopened its status stream after each failure",
        timeout: 20_000,
      })
      .toBe(failures + 1);
    const reopenedAt = streams[failures]!;
    expect(
      presence.filter((at) => at < reopenedAt).length,
      "presence was renewed while the stream was down",
    ).toBeGreaterThan(0);
    await page.waitForTimeout(outlastHostTimers);
    const download = await httpDownload(url, 20_000);
    expect(download.status, download.failure ?? JSON.stringify(download.json)).toBe(200);
    expect(download.sha256).toBe(file.sha256);
    expect(streams.length, "an open stream is not reopened again").toBe(failures + 1);
    expect(
      presence.filter((at) => at > reopenedAt + 5000),
      "no presence renewals once the stream is back",
    ).toEqual([]);
    await expect(shareItem(page, file.name).getByRole("button", { name: ui.buttons.retry })).toHaveCount(0);
  });
}

test("five shares use one status stream and no status polling, across in-page navigation", async ({
  page,
  baseURL,
}) => {
  const streams: string[] = [];
  const statusGets: { path: string; at: number }[] = [];
  const presence: number[] = [];
  const subscribed = new Set<string>();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (TRACKER.test(request.url())) streams.push(request.resourceType());
    else if (isPresence(request.method(), request.url())) presence.push(Date.now());
    else if (request.method() === "POST" && /\/subscribe\//.test(path))
      subscribed.add(path.replace(/\/subscribe\/.*$/, ""));
    else if (request.method() === "GET" && /^\/api\/(channels|v1\/channel)\//.test(path))
      statusGets.push({ path, at: Date.now() });
  });
  const files = Array.from({ length: 5 }, (_, index) => syntheticFile(`one-stream-${index + 1}.bin`, 32 * 1024));
  await page.goto("/");
  await addFiles(page, files);
  const urls = [];
  for (const file of files) urls.push(await shareDownloadUrl(page, file.name));
  await expect.poll(() => subscribed.size, { message: "every share is carried by the page stream" }).toBe(files.length);
  const windowStart = Date.now();
  await page.waitForTimeout(8000);
  await navLink(page, ui.nav.recipes).click();
  await expect(page).toHaveURL(`${baseURL}/recipes`);
  await page.waitForTimeout(4000);
  await navLink(page, ui.nav.home).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await page.waitForTimeout(Math.max(0, 20_000 - (Date.now() - windowStart)));
  expect(streams, "exactly one EventSource to /api/v1/track").toEqual(["eventsource"]);
  expect(
    statusGets.filter(({ at }) => at >= windowStart),
    "no status GETs while the stream is open",
  ).toEqual([]);
  const paths = statusGets.map(({ path }) => path);
  expect(new Set(paths).size, `no repeated status GETs: ${paths.join(", ")}`).toBe(paths.length);
  expect(
    presence.filter((at) => at >= windowStart),
    "no presence renewals while the stream is open",
  ).toEqual([]);
  for (const [index, file] of files.entries()) {
    const download = await httpDownload(urls[index]!);
    expect(download.status, download.failure ?? file.name).toBe(200);
    expect(download.sha256, file.name).toBe(file.sha256);
  }
  expect(streams.length, "still one stream after the downloads").toBe(1);
});

// HTTP/1.1 allows a browser six connections per host. Receiver tabs must not hold any open while
// they wait, or a sender tab and its downloads can no longer reach the relay.
test("a sender tab and six receiver tabs in one browser all finish their downloads", async ({
  context,
  browserName,
}) => {
  // Playwright's Firefox driver stops reporting navigations of later tabs in one context, although the pages load.
  test.skip(
    browserName === "firefox",
    "Playwright's Firefox driver loses navigation events past a few tabs per context",
  );
  const sender = await context.newPage();
  await sender.goto("/");
  const file = syntheticFile("six-receivers.bin", 256 * 1024);
  await addFiles(sender, [file]);
  const humanUrl = await shareHumanUrl(sender, file.name);
  const receivers = [];
  for (let index = 0; index < 6; index += 1) {
    const receiver = await context.newPage();
    await receiver.goto(humanUrl);
    await expectDownloadEnabled(receiver);
    receivers.push(receiver);
  }
  for (const [index, receiver] of receivers.entries()) {
    const download = receiver.waitForEvent("download", { timeout: 20_000 });
    await downloadControl(receiver).click();
    const path = await (await download).path();
    expect(sha256(await readFile(path)), `receiver ${index + 1}`).toBe(file.sha256);
  }
  await expect(shareItem(sender, file.name)).toContainText(ui.row.count(6));
});

test("an upload cut by a relay restart is sent again automatically to the next receiver", async ({
  page,
  airshare,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  const file = syntheticFile("restart-mid-upload.bin", 8 * 1024 * 1024);
  await addFiles(page, [file]);
  const url = await shareDownloadUrl(page, file.name);
  // A slow receiver keeps the upload running long enough to restart the relay in the middle of it.
  const first = curlDownload(url, test.info().outputPath(), 60, ["--limit-rate", "1M"]);
  const bar = shareItem(page, file.name).getByRole("progressbar");
  await expect
    .poll(async () => Number(await bar.getAttribute("aria-valuenow")), { timeout: 20_000 })
    .toBeGreaterThan(0);
  try {
    // The relay stays down long enough that the browser cannot quietly resend the upload itself, and the
    // default 2 s grace would end the share before the page's stream reconnects (about 3 s).
    await airshare.restart({ settings: { HOST_GRACE_MS: "20000" }, downtimeMs: 3000 });
    expect((await first).exitCode, "the receiver in flight was cut off by the restart").not.toBe(0);
    const second = await curlDownload(url, test.info().outputPath(), 60);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.sha256).toBe(file.sha256);
    await expect(shareItem(page, file.name).getByRole("button", { name: ui.buttons.retry })).toBeHidden();
  } finally {
    await airshare.restart();
  }
});
