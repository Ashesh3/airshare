/// <reference lib="dom" />
import { test, expect, HOST_GRACE_MS, syntheticFile, httpDownload, crashPage, createApiChannel } from "./fixtures";
import { ui, addFiles, shareItem, expectEmptyList, shareDownloadUrl } from "./ui";

// Contract item 26: the home-page share list lives in memory only, and a share ends with its tab.
test.describe("share list starts empty in every new document", () => {
  test("reload starts with an empty list", async ({ page }) => {
    await page.goto("/");
    await addFiles(page, [syntheticFile("reload-me.txt", 2048, "text/plain")]);
    await page.reload();
    await expectEmptyList(page);
  });

  test("closing the tab and opening the site again starts with an empty list", async ({ context }) => {
    const first = await context.newPage();
    await first.goto("/");
    await addFiles(first, [syntheticFile("closed-tab.txt", 2048, "text/plain")]);
    await first.close();
    const reopened = await context.newPage();
    await reopened.goto("/");
    await expectEmptyList(reopened);
  });

  test("a new tab opened while another tab is sharing starts with an empty list", async ({ context }) => {
    const sharing = await context.newPage();
    await sharing.goto("/");
    await addFiles(sharing, [syntheticFile("tab-a-new-tab.txt", 2048, "text/plain")]);
    const fresh = await context.newPage();
    await fresh.goto("/");
    await expectEmptyList(fresh);
    await expect(shareItem(sharing, "tab-a-new-tab.txt")).toBeVisible();
  });

  test("a second tab opened from the sharing tab starts with an empty list", async ({ page }) => {
    await page.goto("/");
    await addFiles(page, [syntheticFile("opener-tab.txt", 2048, "text/plain")]);
    // window.open copies sessionStorage into the new tab, unlike a fresh tab.
    const [second] = await Promise.all([
      page.waitForEvent("popup"),
      page.evaluate(() => {
        window.open("/", "_blank");
      }),
    ]);
    await second.waitForLoadState();
    await expectEmptyList(second);
  });
});

test("tab A keeps sharing while tab B is open", async ({ context }) => {
  const file = syntheticFile("tab-a-keeps-sharing.bin", 256 * 1024);
  const tabA = await context.newPage();
  await tabA.goto("/");
  await addFiles(tabA, [file]);
  const url = await shareDownloadUrl(tabA, file.name);
  const tabB = await context.newPage();
  await tabB.goto("/");
  await expectEmptyList(tabB);
  const download = await httpDownload(url);
  expect(download.status).toBe(200);
  expect(download.sha256, "downloaded bytes match the file shared in tab A").toBe(file.sha256);
  await expect(shareItem(tabA, file.name)).toBeVisible();
  await expectEmptyList(tabB);
});

test.describe("no share data in browser storage", () => {
  test("localStorage, sessionStorage, cookies and IndexedDB stay empty after sharing", async ({ page }) => {
    await page.goto("/");
    await addFiles(page, [
      syntheticFile("storage-check-1.txt", 1024, "text/plain"),
      syntheticFile("storage-check-2.txt", 1024, "text/plain"),
    ]);
    const stored = await page.evaluate(async () => ({
      localStorage: Object.keys(localStorage),
      sessionStorage: Object.keys(sessionStorage),
      cookie: document.cookie,
      indexedDB: (await indexedDB.databases()).map((database) => database.name),
    }));
    expect(stored).toEqual({ localStorage: [], sessionStorage: [], cookie: "", indexedDB: [] });
  });

  test("a pre-seeded legacy share key is removed on startup", async ({ page, baseURL }) => {
    // The shape older AirShare versions stored: owner capabilities plus original file details.
    const channel = await createApiChannel(baseURL!, "legacy-share.bin", 16);
    await page.goto("/healthz");
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
      ui.legacyStorageKey,
      JSON.stringify([{ channel, originalFile: { name: "legacy-share.bin", size: 16, lastModified: 1 } }]),
    ] as const);
    await page.goto("/");
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), ui.legacyStorageKey)).toBeNull();
    await expectEmptyList(page);
  });
});

test.describe("the share ends when its tab is gone", () => {
  test("closing the sender tab gives receivers 410 sender_left instead of a hang", async ({ context }) => {
    const sender = await context.newPage();
    await sender.goto("/");
    const file = syntheticFile("closed-sender.bin", 32 * 1024);
    await addFiles(sender, [file]);
    const url = await shareDownloadUrl(sender, file.name);
    await sender.close();
    const receiver = await httpDownload(url, HOST_GRACE_MS + 8000);
    expect(receiver.status, receiver.failure).toBe(410);
    expect(receiver.json).toEqual(ui.closed.sender_left);
    expect(receiver.elapsedMs).toBeLessThanOrEqual(HOST_GRACE_MS + 4000);
  });

  test("a receiver gets 410 sender_left within the grace period after the sender tab crashes", async ({ page }) => {
    await page.goto("/");
    const file = syntheticFile("crashed-sender.bin", 32 * 1024);
    await addFiles(page, [file]);
    const url = await shareDownloadUrl(page, file.name);
    // Chromium can take a few seconds to report the crash, so the clock starts once the tab is gone.
    await crashPage(page);
    const crashedAt = Date.now();
    // The receiver starts waiting after the tab is gone, so only the server's grace timer can end it.
    // A page with an open status stream holds no presence lease, so the grace starts when the stream drops.
    // A connection reset before any response is the test client's own (see httpDownload), so it is retried once.
    const receiver = await httpDownload(url, HOST_GRACE_MS + 8000, { retryBeforeHeaders: true });
    if (receiver.retried) test.info().annotations.push({ type: "retried", description: receiver.retried });
    expect(
      receiver.status,
      receiver.retried ? `${receiver.failure} (first attempt: ${receiver.retried})` : receiver.failure,
    ).toBe(410);
    expect(receiver.json).toEqual(ui.closed.sender_left);
    expect(Date.now() - crashedAt, "the share closes about one grace period after the crash").toBeLessThanOrEqual(
      HOST_GRACE_MS + 1500,
    );
  });
});

test("leaving the page while a share is live asks for confirmation", async ({ page }) => {
  await page.goto("/");
  await addFiles(page, [syntheticFile("leave-warning.txt", 1024, "text/plain")]);
  await expect(shareItem(page, "leave-warning.txt")).toBeVisible();
  const dialog = page.waitForEvent("dialog", { timeout: 5000 });
  await page.close({ runBeforeUnload: true });
  const prompt = await dialog;
  expect(prompt.type()).toBe("beforeunload");
  await prompt.dismiss();
  await expect(
    shareItem(page, "leave-warning.txt"),
    "dismissing the prompt keeps the page and its share",
  ).toBeVisible();
});
