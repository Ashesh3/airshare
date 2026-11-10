/// <reference lib="dom" />
import { expect, type Locator, type Page } from "@playwright/test";

// Every visible string and role the suite depends on lives here, so wording
// changes from the frontend only need to be applied in one place.
export const ui = {
  emptyList: "No files have been added yet",
  addFileZone: /Drag & drop to share a file/i,
  sharedFilesHeading: "Shared files",
  buttons: {
    delete: /^delete$/i,
    copyShareUrl: /^share URL$/i,
    send: /^Send$/,
    download: /^Download$/,
    retry: "Retry transfer",
  },
  nav: { home: "Home", recipes: "Recipes", about: "About" },
  headings: { recipes: "Recipes", about: "About" },
  titles: {
    home: "AirShare",
    recipes: "AirShare Recipes",
    about: "AirShare About",
    privacy: "AirShare Privacy",
    license: "AirShare License",
    download: "AirShare Download",
    upload: "AirShare Upload",
    notFound: "AirShare Page Not Found",
  },
  receiver: {
    waiting: /Waiting for the sender/i,
    senderLeft: "The sender stopped sharing this file.",
    unavailable: "This share is no longer available.",
    alertBackground: "rgb(192, 57, 43)",
  },
  // JSON bodies of 410 responses for closed shares.
  closed: {
    sender_left: { error: "The sender stopped sharing this file.", reason: "sender_left" },
    deleted: { error: "This share was deleted.", reason: "deleted" },
  },
  send: { fileLabel: "File to send", stillSharing: "Still sharing with anyone who opens the request link" },
  // Station307-style toasts in #notice (role=status), one at a time, text in .message.
  toasts: {
    added: (name: string) => `Added ${name}`,
    dropped: (count: number) => `${count} ${count === 1 ? "file" : "files"} added`,
    starting: (name: string) => `Starting upload of ${name}`,
    succeeded: "A transfer succeeded",
    failed: "A transfer failed",
    sharingLinkCopied: "Sharing link copied",
    directLinkCopied: "Direct download link copied",
    uploadCompleted: "Upload completed",
    copyFailed: "Could not copy the link",
    addFailed: (name: string, error: string) => `Could not add ${name}: ${error}`,
    senderLeft: (name: string) => `${name} stopped sharing. Add it again to share it.`,
    noLongerShared: (name: string) => `${name} is no longer shared. Add it again to share it.`,
  },
  row: {
    preparing: "preparing transfer...",
    count: (uploads: number) => `(${uploads} ${uploads === 1 ? "upload" : "uploads"})`,
  },
  dropOverlay: {
    selector: "#drop-overlay",
    text: "Drop your file to share it",
    sendText: "Drop your file to send it",
    activeClass: /\bactive\b/,
  },
  recipeColors: { background: "rgb(44, 62, 80)", text: "rgb(239, 215, 99)" },
  moreRecipes: {
    heading: "More recipes?",
    link: "github.com/Ashesh3/airshare/issues",
    href: "https://github.com/Ashesh3/airshare/issues",
  },
  notFound: { hero: "Uhoh!", heading: "404 Page Not Found", body: "The page you requested does not exist!" },
  footerLinks: ["privacy", "license"],
  legacyStorageKey: "airshare.shares.v1",
} as const;

export type SyntheticFile = { name: string; mimeType: string; buffer: Buffer; sha256: string };

export async function addFiles(page: Page, files: SyntheticFile[]) {
  const chooser = page.waitForEvent("filechooser");
  // A transparent file input may cover the drop zone; click where the user would, whatever is on top.
  await page.getByText(ui.addFileZone).click({ force: true });
  await (await chooser).setFiles(files.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
  for (const file of files) await expect(shareItem(page, file.name)).toBeVisible();
}

/** The innermost element that shows this file's name and its delete control. */
export function shareItem(page: Page, name: string): Locator {
  return page
    .locator("li, article, section, div, tr")
    .filter({ hasText: name })
    .filter({ has: page.getByRole("button", { name: ui.buttons.delete }) })
    .last();
}

export async function expectEmptyList(page: Page) {
  await expect(page.getByText(ui.emptyList)).toBeVisible();
  await expect(page.getByRole("button", { name: ui.buttons.delete })).toHaveCount(0);
}

/** The direct transfer URL shown in the share row (not the human receiver page). */
export async function shareDownloadUrl(page: Page, name: string) {
  const item = shareItem(page, name);
  await expect(item).toBeVisible();
  const transferUrl = async () => {
    const urls = (await item.innerText()).match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    return urls.find((candidate) => !/^\/(r|recv)\//.test(new URL(candidate).pathname)) ?? urls[0] ?? "";
  };
  // The row reads "preparing transfer..." until the server has created its link.
  await expect.poll(transferUrl, { message: `a transfer URL is shown for ${name}` }).toMatch(/^https?:\/\//);
  return transferUrl();
}

export function toastRegion(page: Page) {
  return page.locator("#notice");
}
export function toastMessage(page: Page) {
  return page.locator("#notice .message");
}

/**
 * Records every toast the page shows, in order. Toasts last about 1.5 s each, so polling the region
 * could miss one; a MutationObserver sees each message as it is written.
 */
export async function recordToasts(page: Page) {
  await page.evaluate(() => {
    const message = document.querySelector("#notice .message")!;
    const seen: { text: string; at: number; error: boolean }[] = [];
    (window as unknown as { __airshareToasts: typeof seen }).__airshareToasts = seen;
    new MutationObserver(() => {
      const text = message.textContent ?? "";
      if (text)
        seen.push({
          text,
          at: performance.now(),
          error: document.querySelector("#notice")!.classList.contains("is-error"),
        });
    }).observe(message, { childList: true, characterData: true, subtree: true });
  });
  return {
    all: () =>
      page.evaluate(
        () =>
          (window as unknown as { __airshareToasts: { text: string; at: number; error: boolean }[] }).__airshareToasts,
      ),
    texts: async () =>
      (await page.evaluate(() => (window as unknown as { __airshareToasts: { text: string }[] }).__airshareToasts)).map(
        (toast) => toast.text,
      ),
  };
}

/**
 * The human receiver link that the row's share URL button copies. Chromium lets a test read the
 * clipboard; Firefox and WebKit don't grant clipboard permissions to tests, so there the text is
 * recorded as the page copies it, through the Clipboard API or the execCommand fallback.
 */
export async function shareHumanUrl(page: Page, name: string) {
  const origin = new URL(page.url()).origin;
  // Only Chromium knows both permissions; a failed grant in WebKit still breaks later newPage() calls.
  const readable = page.context().browser()?.browserType().name() === "chromium";
  if (readable) await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const button = shareItem(page, name).getByRole("button", { name: ui.buttons.copyShareUrl });
  if (readable) {
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await button.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^https?:\/\//);
    return page.evaluate(() => navigator.clipboard.readText());
  }
  await page.evaluate(() => {
    const copied: string[] = [];
    (window as unknown as { __airshareCopied: string[] }).__airshareCopied = copied;
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      const write = clipboard.writeText.bind(clipboard);
      clipboard.writeText = (text: string) =>
        write(text).then(() => {
          copied.push(text);
        });
    }
    const exec = document.execCommand.bind(document);
    document.execCommand = (command: string, showUI?: boolean, value?: string) => {
      const done = exec(command, showUI, value);
      if (command === "copy" && done) copied.push((document.activeElement as HTMLTextAreaElement | null)?.value ?? "");
      return done;
    };
  });
  await button.click();
  const last = () =>
    page.evaluate(() => (window as unknown as { __airshareCopied: string[] }).__airshareCopied.at(-1) ?? "");
  await expect.poll(last).toMatch(/^https?:\/\//);
  return last();
}

export function navLink(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name, exact: true });
}

export function downloadControl(page: Page) {
  return page.getByText(ui.buttons.download);
}

async function downloadUsable(page: Page) {
  return downloadControl(page).evaluate((element) => {
    const disabled =
      (element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true";
    const deadLink = element.tagName === "A" && !element.hasAttribute("href");
    return !disabled && !deadLink;
  });
}

export async function expectDownloadEnabled(page: Page) {
  await expect(downloadControl(page)).toBeVisible();
  await expect.poll(() => downloadUsable(page), { message: "Download should be usable" }).toBe(true);
}

/** A link that can no longer be used offers no Download: the control is gone (Station307's red alert) or visibly disabled. */
export async function expectDownloadDisabled(page: Page) {
  await expect
    .poll(async () => !(await downloadControl(page).isVisible()) || !(await downloadUsable(page)), {
      message: "Download should not be offered",
    })
    .toBe(true);
}

/** Visually hidden (1px, screen-reader-only) text does not count as visible to a user. */
export async function expectReadable(locator: Locator, timeout?: number) {
  await expect(locator).toBeVisible({ timeout });
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        return box ? box.width >= 16 && box.height >= 8 : false;
      },
      { message: "text should be rendered at a readable size, not visually hidden" },
    )
    .toBe(true);
}

/** Marks the current document; markerSurvives() is false after any full page load. */
export async function markDocument(page: Page) {
  return page.evaluate(() => {
    const marker = crypto.randomUUID();
    (window as unknown as { __airshareE2E: string }).__airshareE2E = marker;
    return marker;
  });
}

export async function markerSurvives(page: Page, marker: string) {
  return page.evaluate(
    (expected) => (window as unknown as { __airshareE2E?: string }).__airshareE2E === expected,
    marker,
  );
}
