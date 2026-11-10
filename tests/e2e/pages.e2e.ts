import {
  test,
  expect,
  HOST_GRACE_MS,
  syntheticFile,
  crashPage,
  httpDownload,
  createApiChannel,
  createReceiveRequest,
} from "./fixtures";
import {
  ui,
  addFiles,
  shareItem,
  shareHumanUrl,
  shareDownloadUrl,
  expectDownloadEnabled,
  expectDownloadDisabled,
  expectReadable,
  navLink,
  downloadControl,
} from "./ui";

// Contract item 23 (receiver view), exercised as item 26 requires.
test.describe("receiver page states", () => {
  test("shows a visible waiting state while the sender is offline", async ({ page, baseURL }) => {
    const channel = await createApiChannel(baseURL!, "nobody-hosting.bin");
    await page.goto(channel.humanUrl);
    await expectReadable(page.getByText(ui.receiver.waiting));
  });

  for (const how of ["closed", "crashed"] as const) {
    test(`shows that the sender stopped sharing after the sender tab is ${how}`, async ({ context }) => {
      const sender = await context.newPage();
      await sender.goto("/");
      const file = syntheticFile(`receiver-stop-${how}.bin`, 16 * 1024);
      await addFiles(sender, [file]);
      const humanUrl = await shareHumanUrl(sender, file.name);
      const receiver = await context.newPage();
      await receiver.goto(humanUrl);
      await expectDownloadEnabled(receiver);
      await expect(receiver.getByText(ui.receiver.senderLeft)).toHaveCount(0);
      await downloadControl(receiver).focus();
      if (how === "closed") await sender.close();
      else await crashPage(sender);
      // A crashed tab can't say goodbye: its share ends once its status stream drops and the grace period runs out.
      await expectReadable(
        receiver.getByText(ui.receiver.senderLeft),
        how === "closed" ? undefined : HOST_GRACE_MS + 8000,
      );
      await expectDownloadDisabled(receiver);
      await expect(downloadControl(receiver)).toBeHidden();
      await expect(
        receiver.getByText(ui.receiver.senderLeft),
        "keyboard focus moves from Download to the alert",
      ).toBeFocused();
    });
  }

  test("an unknown link shows the red alert in place of Download", async ({ page }) => {
    await page.goto("/r/AAAAAAAAAAAAAAAAAAAAAA");
    const alert = page.getByText(ui.receiver.unavailable);
    await expectReadable(alert);
    await expect(alert).toHaveCSS("background-color", ui.receiver.alertBackground);
    const contrast = await alert.evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (color: string) => {
        const [r, g, b] = color
          .match(/\d+/g)!
          .slice(0, 3)
          .map((value) => {
            const channel = Number(value) / 255;
            return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const [light, dark] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
      return (light! + 0.05) / (dark! + 0.05);
    });
    expect(contrast, "the alert text meets WCAG AA contrast").toBeGreaterThanOrEqual(4.5);
    await expect(downloadControl(page)).toBeHidden();
  });

  test("shows that the share is no longer available after the sender deletes it", async ({ context }) => {
    const sender = await context.newPage();
    await sender.goto("/");
    const file = syntheticFile("receiver-deleted.bin", 16 * 1024);
    await addFiles(sender, [file]);
    const humanUrl = await shareHumanUrl(sender, file.name);
    const downloadUrl = await shareDownloadUrl(sender, file.name);
    const receiver = await context.newPage();
    await receiver.goto(humanUrl);
    await expectDownloadEnabled(receiver);
    await shareItem(sender, file.name).getByRole("button", { name: ui.buttons.delete }).click();
    await expectReadable(receiver.getByText(ui.receiver.unavailable));
    await expectDownloadDisabled(receiver);
    const late = await httpDownload(downloadUrl);
    expect(late.status, "an explicit delete is reported as deleted").toBe(410);
    expect(late.json).toEqual(ui.closed.deleted);
  });
});

test("browsers get the styled 404 page; other clients keep the plain 404", async ({ page, baseURL }) => {
  const response = await page.goto("/this-page-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle(ui.titles.notFound);
  await expect(page.getByText(ui.notFound.hero, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: ui.notFound.heading })).toBeVisible();
  await expect(page.getByText(ui.notFound.body)).toBeVisible();
  await expect(navLink(page, ui.nav.home)).toBeVisible();
  for (const name of ui.footerLinks)
    await expect(page.getByRole("contentinfo").getByRole("link", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: ui.notFound.heading })).toHaveCSS("text-align", "left");

  const api = await fetch(`${baseURL}/api/no-such-route`, { headers: { accept: "application/json" } });
  expect(api.status).toBe(404);
  expect(api.headers.get("content-type") ?? "").not.toContain("text/html");
});

test("the footer marks the current page's link like Station307", async ({ page }) => {
  const footerLink = (name: string) => page.getByRole("contentinfo").getByRole("link", { name, exact: true });
  for (const current of ui.footerLinks) {
    await page.goto(`/${current}`);
    for (const name of ui.footerLinks) {
      if (name === current) await expect(footerLink(name)).toHaveAttribute("aria-current", "page");
      else await expect(footerLink(name)).not.toHaveAttribute("aria-current", "page");
      await expect(footerLink(name)).toHaveCSS("text-decoration-line", name === current ? "underline" : "none");
    }
  }
  await page.goto("/");
  for (const name of ui.footerLinks) await expect(footerLink(name)).not.toHaveAttribute("aria-current", "page");
});

test("page titles follow the AirShare pattern", async ({ page, baseURL }) => {
  const channel = await createApiChannel(baseURL!, "title-check.bin");
  const request = await createReceiveRequest(baseURL!);
  const cases: [string, string][] = [
    ["/", ui.titles.home],
    ["/recipes", ui.titles.recipes],
    ["/about", ui.titles.about],
    ["/privacy", ui.titles.privacy],
    ["/license", ui.titles.license],
    [channel.humanUrl, ui.titles.download],
    [request.sendPageUrl, ui.titles.upload],
    ["/no-such-page", ui.titles.notFound],
  ];
  for (const [path, title] of cases) {
    await page.goto(path);
    await expect(page, `title of ${path}`).toHaveTitle(title);
  }
  await page.goto("/");
  await navLink(page, ui.nav.recipes).click();
  await expect(page, "title after in-page navigation").toHaveTitle(ui.titles.recipes);
});

test("no console errors and no CSP violations on any page", async ({ context, baseURL, issues }) => {
  const page = await context.newPage();
  await page.goto("/");
  await addFiles(page, [syntheticFile("console-check.bin", 8 * 1024)]);
  await page.getByRole("button", { name: "QR" }).click();
  await page.keyboard.press("Escape");
  for (const name of [ui.nav.recipes, ui.nav.about, ui.nav.home]) {
    await navLink(page, name).click();
    await page.waitForLoadState("networkidle");
  }
  const channel = await createApiChannel(baseURL!, "console-receiver.bin");
  const request = await createReceiveRequest(baseURL!);
  for (const path of [
    "/recipes",
    "/about",
    "/privacy",
    "/license",
    channel.humanUrl,
    request.sendPageUrl,
    "/no-such-page",
  ]) {
    const other = await context.newPage();
    await other.goto(path);
    await other.waitForLoadState("networkidle");
    await other.close();
  }
  expect(issues.cspViolations, "CSP violations").toEqual([]);
  expect(issues.pageErrors, "uncaught page errors").toEqual([]);
  expect(issues.consoleErrors, "console errors").toEqual([]);
});

test("HTML pages send the Content-Security-Policy and Cross-Origin-Opener-Policy headers", async ({
  request,
  baseURL,
}) => {
  const channel = await createApiChannel(baseURL!, "csp-check.bin");
  const receive = await createReceiveRequest(baseURL!);
  for (const path of [
    "/",
    "/recipes",
    "/about",
    "/privacy",
    "/license",
    channel.humanUrl,
    receive.sendPageUrl,
    "/no-such-page",
  ]) {
    const response = await request.get(path, { headers: { accept: "text/html" } });
    const csp = response.headers()["content-security-policy"] ?? "";
    const directives = new Map(
      csp
        .split(";")
        .map((part) => part.trim().split(/\s+/))
        .filter((parts) => parts[0])
        .map(([name, ...values]) => [name!, values]),
    );
    expect(directives.get("default-src"), `${path} default-src`).toEqual(["'self'"]);
    expect(directives.get("script-src"), `${path} script-src`).toEqual(["'self'"]);
    expect(directives.get("frame-ancestors"), `${path} frame-ancestors`).toEqual(["'none'"]);
    expect(directives.get("base-uri"), `${path} base-uri`).toEqual(["'none'"]);
    expect(response.headers()["cross-origin-opener-policy"], `${path} COOP`).toBe("same-origin");
  }
});
