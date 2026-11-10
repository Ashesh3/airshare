# Station307 parity

This table compares AirShare with the public Station307 service (station307.com) as checked in November 2026. AirShare is an independent project; it reimplements the workflows and does not ship Station307 code or branding.

- **Matches**: the same visible behaviour or output, with AirShare's own name and host.
- **Better**: the same workflow, plus something Station307 lacks or gets wrong.
- **Exception**: a deliberate difference, explained under [Exceptions](#exceptions).

Evidence names a test in `tests/`. Browser scenarios are Playwright tests in `tests/e2e/`; the visual rows were also compared side by side with station307.com at 375, 576, 768, 1280 and 1728 px.

## Browser: sharing a file

| Station307 feature or behaviour | AirShare | Evidence |
| --- | --- | --- |
| Pick a file or drop it anywhere on the page; a full-page "Drop your file to share it" overlay | Matches; dragged text and links are ignored | `e2e/station-ui.e2e.ts`: "a file dropped anywhere on the page is shared; dragged text and links are not" |
| Row appears at once as "preparing transfer..." with only delete | Matches | `frontend.test.ts`: "a new row appears at once as preparing transfer with only delete until its channel exists" |
| Row: name, "(N uploads)", plain-text direct link, QR, share URL, copy URL, delete, progress bar that resets | Matches | `e2e/station-ui.e2e.ts`: "a share row shows a plain-text URL, counts uploads and resets its progress bar" |
| Upload counter | Better: counts every transfer (Station307 misses the first one of each share) | same test |
| Toasts: "Added X", "Starting upload of X", "A transfer succeeded", "A transfer failed", copy confirmations, one at a time | Matches, with [toast differences](#exceptions) | `e2e/station-ui.e2e.ts`: "toasts announce adds and transfers one at a time, in order" |
| QR overlay for the download page, 0.3 s fade | Matches; also closes on Escape and returns focus (Better) | `frontend.test.ts`: "the QR overlay uses a local image, closes on its image and restores the trigger focus" |
| Several waiting receivers share one upload; a later receiver gets the next complete upload | Matches | `server.test.ts`: "a receiver arriving mid-transfer waits for the next complete upload"; `e2e/resilience.e2e.ts`: "a sender tab and six receiver tabs in one browser all finish their downloads" |
| Sender progress | Better: follows actual delivery (Station307 jumps ahead of a slow receiver) | `frontend.test.ts`: "100% browser upload progress does not claim that receivers have finished, and the bar resets afterwards" |
| A failed upload | Better: the row shows the error and Retry transfer | `frontend.test.ts`: "a failed upload stays failed until Retry" |
| Leaving the page | Better: asks for confirmation while a share is live (Station307 never asks) | `e2e/lifecycle.e2e.ts`: "leaving the page while a share is live asks for confirmation" |
| The list lives only in the tab; nothing is stored in the browser | Matches | `e2e/lifecycle.e2e.ts`: "reload starts with an empty list", "localStorage, sessionStorage, cookies and IndexedDB stay empty after sharing" |

## Browser: download page and Send page

| Station307 feature or behaviour | AirShare | Evidence |
| --- | --- | --- |
| Download page: "Someone shares a file with you", "Continue to download *name*", Download through the browser's download manager | Matches | `e2e/smoke.e2e.ts`: "smoke: a shared file downloads with curl and its receiver page offers Download" |
| Unknown link: red "Could not find details" alert, no Download | Matches the layout, with AirShare's wording and [alert colour](#exceptions) | `e2e/pages.e2e.ts`: "an unknown link shows the red alert in place of Download" |
| Sender left or share deleted while the page is open | Better: the page notices through [receiver polling](#exceptions) and says why | `e2e/pages.e2e.ts`: "shows that the sender stopped sharing after the sender tab is closed", "shows that the share is no longer available after the sender deletes it" |
| Sender offline | Better: a visible "Waiting for the sender…" | `e2e/pages.e2e.ts`: "shows a visible waiting state while the sender is offline" |
| Send page for a terminal receive-first request: pick a file, Send, progress bar, "Upload completed" | Matches | `e2e/smoke.e2e.ts`: "smoke: the Send page answers a terminal receive request" |
| A later receiver on the Send page | Exception: [automatic re-sending](#exceptions) | `e2e/station-ui.e2e.ts`: "the Send page confirms the upload and keeps serving later receivers" |
| A file dropped on the Send page | Exception: fills the Send form instead of starting a home share | `e2e/station-ui.e2e.ts`: "a file dropped on the Send page fills its form, and a curl receiver gets it without an extra share" |

## Browser: lifecycle

| Station307 feature or behaviour | AirShare | Evidence |
| --- | --- | --- |
| Closing or reloading the tab stops sharing | Matches; receivers get `410 sender_left` instead of hanging (Better) | `e2e/lifecycle.e2e.ts`: "closing the sender tab gives receivers 410 sender_left instead of a hang" |
| A tab that disappears without closing (crash, lost network) | Exception: its links end after the [grace period](#exceptions) | `e2e/lifecycle.e2e.ts`: "a receiver gets 410 sender_left within the grace period after the sender tab crashes" |
| Recipes, About and other pages open inside the app, so sharing continues and Back returns to the list | Matches | `e2e/navigation.e2e.ts`: "Home → Recipes: a curl download succeeds while Recipes is shown, and Back returns to the live share", "the Send page keeps hosting while another view is shown" |
| One status stream per page | Matches | `e2e/resilience.e2e.ts`: "five shares use one status stream and no status polling, across in-page navigation" |
| A background tab keeps sharing | Matches | `e2e/resilience.e2e.ts`: "five shares stay live while the tab is hidden with timers throttled to once a minute" |
| Relay restart | Better: links survive while the sender stays connected, and a cut upload is sent again automatically | `server.test.ts`: "channel metadata survives restart from a live sender while volatile presence and uploads reset"; `e2e/resilience.e2e.ts`: "an upload cut by a relay restart is sent again automatically to the next receiver" |

## Terminal

| Station307 feature or behaviour | AirShare | Evidence |
| --- | --- | --- |
| `curl -T file -s -L -D - <host> \| grep human`: info line, transfer URL, web URL, QR code rows | Matches | `cli.test.ts`: "curl -T file -s -L -D - <host>: grep human shows the two receiver links, the info line and the QR code" |
| `curl -s -J -O -L -D - <host> \| grep human` to receive first; the sender's name is kept | Matches | `cli.test.ts`: "curl -s -J -O -L -D - <host>: grep human shows sender links, and curl -T to the printed URL keeps its name" |
| A sender keeps hosting with `-L` and serves receivers one after another | Matches; Ctrl+C stops at once (Better) | `cli.test.ts`: "regular-file hosting discovers its basename and serves two complete sequential downloads until cancelled" |
| GNU Wget send and receive | Matches; `wget` without a name in the URL also works (Better) | `wget.test.ts`; `cli.test.ts`: "wget --post-file to the bare host gets a timestamped default name" |
| Long and non-ASCII names | Better: cut to 255 UTF-8 bytes keeping the extension, and `curl -J` gets a reversible percent-encoded name | `cli.test.ts`: "a long terminal file name is cut to 255 UTF-8 bytes and keeps its extension", "a non-ASCII name reaches curl -J as a reversible percent-encoded name" |
| Zero-byte files and empty pipes | Better: delivered (Station307 answers 500) | `cli.test.ts`: "a zero-byte CLI file downloads with Content-Length zero and remains available to the next receiver" |
| One-line pipe recipe `tar … \| curl -s -L -T - -D - <host>/name \| grep human` | Exception: [two-step pipe flow](#exceptions) | `cli.test.ts`: "tar ... \| curl -s -L -T - -D - <host>/name \| grep human shows how to prepare the pipe", "prepared piped stdin sends its complete unknown-length payload directly and exits after one receiver" |
| A waiting sender's output | Exception: [103 liveness hints](#exceptions) | `cli.test.ts`: "103 liveness hints are on by default and off with LIVENESS_HINTS=off" |
| Probes, typos and `HEAD` | Better: only `/` and `/xfr` start a receive; nothing else creates a share | `cli.test.ts`: "only / and /xfr start a terminal receive, and HEAD or an unknown path never creates a channel" |
| Uploading to a web page URL answers `405` with `Allow` | Matches; the answer also names the transfer URL | `cli.test.ts`: "uploading to a browser page answers 405 with Allow and the transfer link to use" |

## API

| Station307 feature or behaviour | AirShare | Evidence |
| --- | --- | --- |
| `POST /api/v1/channel`, `GET /api/v1/track`, tracker subscriptions, `channel_event` and `transfer_event` | Matches for the documented fields | `server.test.ts`: "Station trackers keep Station events: owner subscriptions host, and senders_available means a waiting upload", "transfer events carry timestamps, file details, received bytes, the hash and receiver departures" |
| `com.station307.no-redirect` upload summary with a hash | Matches, with a real SHA-256 of the relayed bytes | `server.test.ts`: "a no-redirect upload answers 200 with a JSON summary; Station clients and x-airshare-hash requests get the payload's SHA-256" |
| Short links (`l.station307.com/<key>/<name>`) | Matches the shape on one host: `/l/<key>/<name>` and `/u/<key>/` | `server.test.ts`: "new keys are 22-character base58 and payloads advertise /u and /l links" |
| A closed share | Better: `410` with `sender_left`, `deleted` or `expired` for an hour, and a final `closed` event | `server.test.ts`: "a deleted share answers 410 with its reason on every API route instead of 404" |
| Other websites | Better: they can't create, change or delete shares, even with a plain link or image | `server.test.ts`: "other websites can't create, change or delete shares, and can read only downloads and status", "a browser that reports another site in Sec-Fetch-Site can't create shares"; `cli.test.ts`: "a browser can't start a terminal receive with a GET, while curl, Wget and PowerShell can" |
| Invalid input | Better: `400`, `413` or `415` instead of `500` | `server.test.ts`: "invalid metadata is a controlled client error" |
| Stored links | Better: only SHA-256 hashes of share keys reach the database | `server.test.ts`: "raw capability keys never reach SQLite, yet after a restart each role's key still opens its links" |
| Byte-identical backend behaviour | Not promised: AirShare's own pages and the documented terminal flows are the supported clients | — |

## Look and pages

| Station307 feature or behaviour | AirShare | Evidence |
| --- | --- | --- |
| Header, nav pills, jumbotron, add-file box, rows, toasts, footer at all widths | Matches, apart from [wrapping on narrow screens](#exceptions) | `e2e/station-ui.e2e.ts`, `e2e/pages.e2e.ts`, side-by-side screenshots |
| Terminal recipe blocks: navy background, yellow monospace; Recipes ends with "More recipes?" | Matches | `e2e/station-ui.e2e.ts`: "recipe code blocks use Station307's colours", "the Recipes page ends by asking for more recipes, as Station307's does" |
| Styled 404 page ("Uhoh!", "404 Page Not Found") | Matches | `e2e/pages.e2e.ts`: "browsers get the styled 404 page; other clients keep the plain 404" |
| Page titles ("Station307 Recipes") | Matches the pattern: "AirShare Recipes" | `e2e/pages.e2e.ts`: "page titles follow the AirShare pattern" |
| Footer link of the current page is underlined | Matches | `e2e/pages.e2e.ts`: "the footer marks the current page's link like Station307" |
| Terms of Service page (`/tos`) | Exception: [License page](#exceptions) | — |
| Keyboard use and reduced motion | Better: skip link, focus ring, file input reachable by Tab, focus kept when Download is replaced, no animation with reduced motion | `frontend.test.ts`: "closing a link while Download has keyboard focus moves focus to the alert that replaces it"; reduced motion checked by hand in Chromium, Firefox and WebKit |

## Exceptions

- **Plain JavaScript instead of SvelteKit.** The pages are plain JavaScript with CSS that reproduces Station307's Bootstrap and Flatly look; the behaviour is what is compared, not the framework.
- **A closed tab ends its links.** A closed or reloaded tab ends its share at once. A tab that vanishes without closing keeps it for `HOST_GRACE_MS` (20 s) so a reconnect or relay restart doesn't end it, then ends it. Station307 keeps such links alive and receivers hang, although nobody can host them again.
- **Automatic re-sending on the Send page.** After Send, the page keeps the file and serves later receivers itself ("Still sharing…", Stop hosting). Station307 needs Send again.
- **Wrapping on narrow screens.** Below 576 px a row's buttons wrap under the name; on Station307 they overlap it.
- **Toast differences.** Dropping several files shows one "N files added" toast, and error toasts stay 4 s so they can be read.
- **Alert contrast colour.** The download page's red alert uses #c0392b instead of #e74c3c, so its white text meets WCAG AA (about 5.4:1 instead of 3.5:1).
- **Receiver polling.** The download page checks the share's status (every 2 s, backing off to 10 s, paused in a hidden tab and after Download) to show that the sender stopped or the share is gone. Station307's page never changes.
- **License page instead of Terms of Service.** AirShare is self-hosted MIT software. The License page states what the project offers; terms of service are between each operator and its users.
- **103 liveness hints.** While a terminal sender waits, the relay sends `HTTP/1.1 103` responses; writing them is how it notices that the sender stopped. `| grep human` hides them, and `LIVENESS_HINTS=off` turns them off.
- **Two-step pipe flow and a grep-visible hint.** A pipe is prepared first and then sent once. Station307's one-line pipe recipe gets `411` with an `x-airshare-human-info` line that shows the two commands, because a proxy can consume part of a non-rewindable input before a redirect.
- **One host for pages, links and API.** Station307 uses separate hosts (`l.`, `xfr.`, `api.`); an AirShare instance serves everything from its own origin.
- **AirShare's own name and legal text.** The name, footer, About, Privacy and License texts are AirShare's, and AirShare is not affiliated with Station307.

## Not verified

- Real Safari on macOS and iOS, and real Firefox on macOS or Windows. Browser tests ran on Chromium (Windows and Linux) and on the Linux builds of Firefox and WebKit in Docker.
- Physical phones. Phones were covered only by device emulation (iPhone 15 on Linux WebKit, Pixel 8 on Chromium).
- A deployment across the Internet. Transfers were tested on one machine and between local Docker containers; Caddy was checked with a local certificate, not a public one.
