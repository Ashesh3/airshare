/// <reference lib="dom" />
import { test, expect, syntheticFile, httpDownload, curlDownload, createReceiveRequest } from "./fixtures";
import {
  ui,
  addFiles,
  shareItem,
  shareDownloadUrl,
  shareHumanUrl,
  expectEmptyList,
  recordToasts,
  toastMessage,
  toastRegion,
} from "./ui";

// Phase 2: the home page, rows, toasts and Send page match Station307's visible behaviour.

test("toasts announce adds and transfers one at a time, in order", async ({ page }) => {
  await page.goto("/");
  const toasts = await recordToasts(page);
  const files = ["toast-a.txt", "toast-b.txt", "toast-c.txt"].map((name) => syntheticFile(name, 4096, "text/plain"));
  await addFiles(page, files);
  await expect(toastRegion(page)).toHaveAttribute("role", "status");
  await expect(toastMessage(page)).toHaveText(ui.toasts.added(files[0]!.name));
  await expect(toastRegion(page)).toHaveClass(/\bactive\b/);
  // Copies jump ahead of queued transfer toasts, so each group is let through before the next starts.
  await expect.poll(toasts.texts, { timeout: 10_000 }).toEqual(files.map((file) => ui.toasts.added(file.name)));
  const url = await shareDownloadUrl(page, files[0]!.name);
  const download = await curlDownload(url, test.info().outputPath());
  expect(download.exitCode, download.stderr).toBe(0);
  expect(download.sha256).toBe(files[0]!.sha256);
  await expect.poll(toasts.texts, { timeout: 10_000 }).toContain(ui.toasts.succeeded);
  await shareHumanUrl(page, files[0]!.name);
  await shareItem(page, files[0]!.name)
    .getByRole("button", { name: /^copy URL$/i })
    .click();
  const expected = [
    ...files.map((file) => ui.toasts.added(file.name)),
    ui.toasts.starting(files[0]!.name),
    ui.toasts.succeeded,
    ui.toasts.sharingLinkCopied,
    ui.toasts.directLinkCopied,
  ];
  await expect.poll(toasts.texts, { timeout: 20_000 }).toEqual(expected);
  const shown = await toasts.all();
  expect(
    shown.filter((toast) => toast.error),
    "no error toasts",
  ).toEqual([]);
  // Queued toasts are shown one after another (about 1.5 s each), not replaced at once.
  for (let index = 1; index < shown.length; index += 1)
    expect(shown[index]!.at - shown[index - 1]!.at, shown[index]!.text).toBeGreaterThan(1200);
  await expect(toastRegion(page)).not.toHaveClass(/\bactive\b/, { timeout: 5000 });
});

async function dataTransferFor(
  page: import("@playwright/test").Page,
  entries: { file?: { name: string; mimeType: string; base64: string }; data?: Record<string, string> },
) {
  return page.evaluateHandle(({ file, data }) => {
    const transfer = new DataTransfer();
    if (file)
      transfer.items.add(
        new File([Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0))], file.name, {
          type: file.mimeType,
        }),
      );
    for (const [type, value] of Object.entries(data ?? {})) transfer.setData(type, value);
    return transfer;
  }, entries);
}

test("a file dropped anywhere on the page is shared; dragged text and links are not", async ({ page }) => {
  await page.goto("/");
  const toasts = await recordToasts(page);
  const hero = page.locator('[data-view="home"] .jumbotron');
  const overlay = page.locator(ui.dropOverlay.selector);
  await expect(hero).toBeVisible();
  expect(
    await hero.evaluate((element) => {
      const box = document.querySelector('[data-view="home"] .add-file');
      return box !== null && !box.contains(element) && !element.contains(box);
    }),
    "the hero is outside the drop box",
  ).toBe(true);
  await expect(overlay).not.toHaveClass(ui.dropOverlay.activeClass);

  const drags: Record<string, string>[] = [
    { "text/plain": "some dragged text" },
    { "text/uri-list": "https://example.com/", "text/plain": "https://example.com/" },
  ];
  for (const data of drags) {
    const transfer = await dataTransferFor(page, { data });
    await hero.dispatchEvent("dragenter", { dataTransfer: transfer });
    await hero.dispatchEvent("dragover", { dataTransfer: transfer });
    await page.waitForTimeout(300);
    await expect(overlay, `no overlay for ${Object.keys(data).join(", ")}`).not.toHaveClass(ui.dropOverlay.activeClass);
    await hero.dispatchEvent("drop", { dataTransfer: transfer });
  }
  await expectEmptyList(page);

  const file = syntheticFile("page-drop.bin", 96 * 1024);
  const transfer = await dataTransferFor(page, {
    file: { name: file.name, mimeType: file.mimeType, base64: file.buffer.toString("base64") },
  });
  await hero.dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(overlay).toHaveClass(ui.dropOverlay.activeClass);
  await expect(overlay).toHaveText(ui.dropOverlay.text);
  await expect(overlay).toHaveCSS("opacity", "1");
  await hero.dispatchEvent("dragover", { dataTransfer: transfer });
  await hero.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(overlay).not.toHaveClass(ui.dropOverlay.activeClass);
  await expect(shareItem(page, file.name)).toBeVisible();
  await expect.poll(toasts.texts).toEqual([ui.toasts.dropped(1)]);
  const download = await httpDownload(await shareDownloadUrl(page, file.name));
  expect(download.status, download.failure).toBe(200);
  expect(download.sha256).toBe(file.sha256);
});

test("a file dropped on the Send page fills its form, and a curl receiver gets it without an extra share", async ({
  page,
  baseURL,
}) => {
  const request = await createReceiveRequest(baseURL!);
  const created: string[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "POST" && new URL(sent.url()).pathname === "/api/channels") created.push(sent.url());
  });
  await page.goto(request.sendPageUrl);
  const file = syntheticFile("send-page-drop.bin", 128 * 1024);
  const transfer = await dataTransferFor(page, {
    file: { name: file.name, mimeType: file.mimeType, base64: file.buffer.toString("base64") },
  });
  const view = page.locator('[data-view="send"]');
  const overlay = page.locator(ui.dropOverlay.selector);
  await view.dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(overlay).toHaveClass(ui.dropOverlay.activeClass);
  await expect(overlay).toHaveText(ui.dropOverlay.sendText);
  await view.dispatchEvent("dragover", { dataTransfer: transfer });
  await view.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(overlay).not.toHaveClass(ui.dropOverlay.activeClass);
  await expect
    .poll(() => page.getByLabel(ui.send.fileLabel).evaluate((input) => (input as HTMLInputElement).files?.[0]?.name))
    .toBe(file.name);
  await page.getByRole("button", { name: ui.buttons.send }).click();
  const download = await curlDownload(request.downloadUrl, test.info().outputPath());
  expect(download.exitCode, download.stderr).toBe(0);
  expect(download.sha256).toBe(file.sha256);
  expect(created, "dropping on the Send page created no home share").toEqual([]);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: ui.nav.home, exact: true }).click();
  await expectEmptyList(page);
});

test("recipe code blocks use Station307's colours", async ({ page }) => {
  for (const [path, view] of [
    ["/recipes", "recipes"],
    ["/", "home"],
  ] as const) {
    await page.goto(path);
    const blocks = page.locator(`[data-view="${view}"] pre`);
    await expect(blocks.first()).toBeVisible();
    for (const block of await blocks.all()) {
      await expect(block, `${path} pre background`).toHaveCSS("background-color", ui.recipeColors.background);
      await expect(block, `${path} pre text`).toHaveCSS("color", ui.recipeColors.text);
      for (const code of await block.locator("code").all())
        await expect(code, `${path} code text`).toHaveCSS("color", ui.recipeColors.text);
    }
  }
});

test("the Recipes page ends by asking for more recipes, as Station307's does", async ({ page }) => {
  await page.goto("/recipes");
  const recipes = page.locator('[data-view="recipes"]');
  const heading = recipes.getByRole("heading", { name: ui.moreRecipes.heading, exact: true });
  await expect(heading).toBeVisible();
  expect(await heading.evaluate((element) => element.tagName)).toBe("H3");
  const last = recipes.locator(":scope > p:last-child");
  await expect(last.getByRole("link", { name: ui.moreRecipes.link, exact: true })).toHaveAttribute(
    "href",
    ui.moreRecipes.href,
  );
  expect(await last.evaluate((element) => element.previousElementSibling?.textContent)).toBe(ui.moreRecipes.heading);
});

test("a share row shows a plain-text URL, counts uploads and resets its progress bar", async ({ page }) => {
  let release!: () => void;
  const created = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Hold channel creation so the placeholder row can be seen.
  await page.route(/\/api\/channels$/, async (route) => {
    if (route.request().method() === "POST") await created;
    await route.continue();
  });
  await page.goto("/");
  const file = syntheticFile("row-check.bin", 3 * 1024 * 1024);
  await addFiles(page, [file]);
  const row = shareItem(page, file.name);
  const urlField = row.locator('[data-field="url"]');
  await expect(urlField).toHaveText(ui.row.preparing);
  release();
  const url = await shareDownloadUrl(page, file.name);
  await expect(urlField).toHaveText(url);
  await expect(row.locator("a"), "the row URL is plain text, not a link").toHaveCount(0);
  await expect(row).toContainText(ui.row.count(0));

  const bar = row.getByRole("progressbar");
  await bar.evaluate((element) => {
    const seen = { max: 0 };
    (window as unknown as { __airshareProgress: typeof seen }).__airshareProgress = seen;
    new MutationObserver(() => {
      seen.max = Math.max(seen.max, Number(element.getAttribute("aria-valuenow")));
    }).observe(element, { attributes: true, attributeFilter: ["aria-valuenow"] });
  });
  // A rate-limited receiver keeps the upload in progress long enough to be seen.
  const first = await curlDownload(url, test.info().outputPath(), 20, ["--limit-rate", "1M"]);
  expect(first.exitCode, first.stderr).toBe(0);
  expect(first.sha256).toBe(file.sha256);
  await expect(row).toContainText(ui.row.count(1));
  expect(
    await page.evaluate(() => (window as unknown as { __airshareProgress: { max: number } }).__airshareProgress.max),
    "the progress bar moved during the transfer",
  ).toBeGreaterThan(0);
  await expect(bar).toHaveAttribute("aria-valuenow", "0");
  // The bar's head is a 6 px border, so the fill is checked through its own width.
  await expect.poll(() => bar.locator("span").evaluate((element) => (element as HTMLElement).style.width)).toBe("0%");

  const second = await httpDownload(url);
  expect(second.sha256).toBe(file.sha256);
  await expect(row).toContainText(ui.row.count(2));
});

test("the Send page confirms the upload and keeps serving later receivers", async ({ page, baseURL }) => {
  const request = await createReceiveRequest(baseURL!);
  const file = syntheticFile("send-page-note.bin", 256 * 1024);
  await page.goto(request.sendPageUrl);
  const toasts = await recordToasts(page);
  await expect(page.getByText(ui.send.stillSharing)).toBeHidden();
  await page
    .getByLabel(ui.send.fileLabel)
    .setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
  await page.getByRole("button", { name: ui.buttons.send }).click();
  await expect(page.getByText(ui.send.stillSharing)).toBeVisible();
  const first = await curlDownload(request.downloadUrl, test.info().outputPath());
  expect(first.exitCode, first.stderr).toBe(0);
  expect(first.sha256).toBe(file.sha256);
  await expect.poll(toasts.texts).toEqual([ui.toasts.uploadCompleted]);
  await expect(page.getByText(ui.send.stillSharing)).toBeVisible();
  // A repeat of a toast that is still fully shown is collapsed, so the next upload starts after it has gone.
  await expect(toastRegion(page)).not.toHaveClass(/\bactive\b/, { timeout: 5000 });
  await expect(toastMessage(page)).toHaveText("");
  const second = await curlDownload(request.downloadUrl, test.info().outputPath());
  expect(second.exitCode, second.stderr).toBe(0);
  expect(second.sha256, "a second curl receiver also gets the file").toBe(file.sha256);
  await expect.poll(toasts.texts).toEqual([ui.toasts.uploadCompleted, ui.toasts.uploadCompleted]);
});

test("case variants of /index.html never serve the raw page template", async ({ request }) => {
  // Windows ignores case and trailing dots or spaces in file names.
  for (const path of [
    "/index.html",
    "/INDEX.HTML",
    "/Index.html",
    "/index.HTML",
    "/%69ndex.html",
    "/index.html.",
    "/INDEX.HTML.",
    "/index.html%20",
  ]) {
    for (const accept of ["text/html", "*/*"]) {
      const response = await request.get(path, { headers: { accept } });
      const body = await response.text();
      const label = `${path} (Accept: ${accept}) → ${response.status()}`;
      for (const raw of ["{{origin}}", "{{year}}"]) expect(body, `${label} contains ${raw}`).not.toContain(raw);
      if (response.status() === 200)
        expect(response.headers()["content-security-policy"] ?? "", `${label} CSP`).toContain("default-src 'self'");
    }
  }
});
