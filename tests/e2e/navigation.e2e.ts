import { test, expect, syntheticFile, httpDownload, curlDownload, createReceiveRequest } from "./fixtures";
import { ui, addFiles, shareItem, shareDownloadUrl, navLink, markDocument, markerSurvives } from "./ui";

// Contract item 20: sharing continues while another view is shown, and Back returns to the live list.
test("Home → Recipes: a curl download succeeds while Recipes is shown, and Back returns to the live share", async ({
  page,
  baseURL,
}) => {
  const file = syntheticFile("nav-recipes.bin", 512 * 1024);
  await page.goto("/");
  await addFiles(page, [file]);
  const url = await shareDownloadUrl(page, file.name);
  const marker = await markDocument(page);

  await navLink(page, ui.nav.recipes).click();
  await expect(page).toHaveURL(`${baseURL}/recipes`);
  await expect(page.getByRole("heading", { name: ui.headings.recipes, exact: true })).toBeVisible();
  const whileOnRecipes = await curlDownload(url, test.info().outputPath());
  expect(whileOnRecipes.exitCode, whileOnRecipes.stderr).toBe(0);
  expect(whileOnRecipes.sha256).toBe(file.sha256);

  await page.goBack();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(shareItem(page, file.name)).toBeVisible();
  expect(await markerSurvives(page, marker), "navigation stays in the same document").toBe(true);
  const afterBack = await httpDownload(url);
  expect(afterBack.status).toBe(200);
  expect(afterBack.sha256, "the share is still live after Back").toBe(file.sha256);
});

test("Home → About → Back → Forward keeps the share live", async ({ page, baseURL }) => {
  const file = syntheticFile("nav-about.bin", 256 * 1024);
  await page.goto("/");
  await addFiles(page, [file]);
  const url = await shareDownloadUrl(page, file.name);
  const marker = await markDocument(page);

  await navLink(page, ui.nav.about).click();
  await expect(page).toHaveURL(`${baseURL}/about`);
  await expect(page.getByRole("heading", { name: ui.headings.about, exact: true })).toBeVisible();
  const onAbout = await curlDownload(url, test.info().outputPath());
  expect(onAbout.exitCode, onAbout.stderr).toBe(0);
  expect(onAbout.sha256).toBe(file.sha256);

  await page.goBack();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(shareItem(page, file.name)).toBeVisible();
  const afterBack = await httpDownload(url);
  expect(afterBack.sha256, "live after Back").toBe(file.sha256);

  await page.goForward();
  await expect(page).toHaveURL(`${baseURL}/about`);
  await expect(page.getByRole("heading", { name: ui.headings.about, exact: true })).toBeVisible();
  const afterForward = await curlDownload(url, test.info().outputPath());
  expect(afterForward.exitCode, afterForward.stderr).toBe(0);
  expect(afterForward.sha256, "live after Forward").toBe(file.sha256);

  await page.goBack();
  await expect(shareItem(page, file.name)).toBeVisible();
  expect(await markerSurvives(page, marker), "Back and Forward stay in the same document").toBe(true);
});

test("the Send page keeps hosting while another view is shown", async ({ page, baseURL }) => {
  const request = await createReceiveRequest(baseURL!);
  const file = syntheticFile("requested-file.bin", 256 * 1024);
  await page.goto(request.sendPageUrl);
  await page
    .getByLabel(ui.send.fileLabel)
    .setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
  await page.getByRole("button", { name: ui.buttons.send }).click();
  const marker = await markDocument(page);

  await navLink(page, ui.nav.recipes).click();
  await expect(page).toHaveURL(`${baseURL}/recipes`);
  await expect(page.getByRole("heading", { name: ui.headings.recipes, exact: true })).toBeVisible();
  const whileOnRecipes = await curlDownload(request.downloadUrl, test.info().outputPath());
  expect(whileOnRecipes.exitCode, whileOnRecipes.stderr).toBe(0);
  expect(whileOnRecipes.sha256).toBe(file.sha256);

  await page.goBack();
  await expect(page).toHaveURL(request.sendPageUrl);
  await expect(page.getByRole("button", { name: ui.buttons.send })).toBeVisible();
  expect(await markerSurvives(page, marker), "navigation stays in the same document").toBe(true);
  // Decision D3: the Send page keeps serving later receivers.
  const later = await httpDownload(request.downloadUrl);
  expect(later.status).toBe(200);
  expect(later.sha256).toBe(file.sha256);
});
