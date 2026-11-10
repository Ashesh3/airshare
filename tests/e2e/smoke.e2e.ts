import { test, expect, syntheticFile, httpDownload, curlDownload, createReceiveRequest } from "./fixtures";
import { ui, addFiles, shareDownloadUrl, shareHumanUrl, expectDownloadEnabled, navLink } from "./ui";

// Positive paths with no navigation or tab lifecycle. If these fail, the harness or the relay is
// broken, not the behaviour the other scenarios check.
test("smoke: a shared file downloads with curl and its receiver page offers Download", async ({ context }) => {
  const page = await context.newPage();
  await page.goto("/");
  const file = syntheticFile("smoke.bin", 300 * 1024);
  await addFiles(page, [file]);
  const url = await shareDownloadUrl(page, file.name);
  const c = await curlDownload(url, test.info().outputPath());
  expect(c.exitCode, c.stderr).toBe(0);
  expect(c.sha256).toBe(file.sha256);
  const h = await httpDownload(url);
  expect(h.sha256).toBe(file.sha256);
  const human = await shareHumanUrl(page, file.name);
  expect(human).toMatch(/\/r\//);
  const r = await context.newPage();
  await r.goto(human);
  await expectDownloadEnabled(r);
  await expect(navLink(page, ui.nav.recipes)).toBeVisible();
});

test("smoke: the Send page answers a terminal receive request", async ({ page, baseURL }) => {
  const request = await createReceiveRequest(baseURL!);
  const file = syntheticFile("requested-smoke.bin", 128 * 1024);
  await page.goto(request.sendPageUrl);
  await page
    .getByLabel(ui.send.fileLabel)
    .setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
  await page.getByRole("button", { name: ui.buttons.send }).click();
  const c = await curlDownload(request.downloadUrl, test.info().outputPath());
  expect(c.exitCode, c.stderr).toBe(0);
  expect(c.sha256).toBe(file.sha256);
  const again = await httpDownload(request.downloadUrl);
  expect(again.sha256).toBe(file.sha256);
});
