# AirShare — final independent review (Claude Opus 5.5, max effort), 2026-11-03

Reviewer: `/root/opus_independent_review`. Read-only with respect to the repository and git. No Chrome, no subagents. All runtime checks ran on private copies bound to `127.0.0.1` ports 47391–47402; every test server has been stopped. No capability keys appear in this report.

## UI CORRECTION REVIEW — Station307 visual-parity pass (snapshot `%TEMP%\airshare-opus-ui-v8-150235`)

**Scope.** Read-only and focused.

| File | Hash |
| --- | --- |
| `public/index.html` | `EDFB71FBFE07` |
| `public/styles.css` | `73E85C0CD742` |
| `public/app.js` | `DCCD0ADD57E3` |
| `public/sender.js` | `8D212DE813FE` |
| `public/receiver.js` | `6AC5D009092E` |
| `src/server.ts` | `B4BFDD08EF32` |
| `public/fonts/*` | 5 WOFF2 files plus OFL notices and sources |

**Unchanged since the accepted review:** `transfer.js`, `http-server.ts`, `admission.ts`, and the streaming, capability and admission code. **Server diff since the accepted state:** only `pageHead`, `pageHeader`, `pageFooter`, `renderPage` markup, `renderInfoPage`, and the GET/HEAD route for `/recipes|/about|/privacy|/license`.

**HTML injection [V-cur].** A slash-free hostile filename `<img src=x onerror=alert(1)><svg onload=alert(2)>&amp;'x.html` survives filename sanitizing.

- On the receiver page it appears only escaped, in both `<title>` and `<i id="file-name">`.
- The bootstrap JSON escapes `<` as `\u003c` on both pages.
- Link `href`s are URL-encoded and wrapped in `escapeHtml`.
- Nothing executable from the filename appears outside the bootstrap.
- Info pages are static except an escaped origin; a hostile `Host` header appeared only as `&quot;`.
- Client scripts write only through `textContent` and DOM properties. Restored shares are kept only when every URL is same-origin, so `javascript:` URLs are dropped.

**Role isolation [V-cur].** The receiver page payload keys are exactly `activeReceivers, activeUpload, bytesTransferred, completedTransfers, downloadUrl, eventsUrl, file, humanUrl, id, role(receiver), senderOnline, statusUrl, waitingReceivers`: no upload or delete URL, no sender key, no owner id. The sender page payload has role `sender`, includes `uploadUrl`, and has no `deleteUrl` or owner id.

**Form wiring and error handling [I].**

- The sender's `<form>` requires a chosen file. Send is disabled until a file is selected, then calls `HostSession.setFile`, so the unchanged state machine keeps hosting.
- Stop clears the selection and pauses. Retry stays hidden unless there is an error.
- Toasts clear after 4 s; errors persist.
- The QR overlay is full-screen, uses the local `/api/qr` image, hides it with a caption if the image fails, and restores focus.
- The home row link is the server-built `downloadUrl`. Default buttons are exactly QR / share URL / copy URL / delete; recovery controls stay hidden unless needed.

**Static files and fonts [V-cur].**

- `/fonts/*.woff2` is served as `font/woff2` with `nosniff`; OFL texts as `text/plain`.
- Encoded traversal under `/fonts/` returns `404`.
- Info pages return `200 text/html` with `no-referrer` and `X-Frame-Options: DENY`, no scripts, and an empty `HEAD`.
- The WOFF2 files are valid (`wOF2` magic): unmodified Lato and Kanit Latin subsets with SIL OFL 1.1 notices and documented sources. `styles.css` loads only local `/fonts/` URLs, with no `@import` or CDN, and has no hashed Svelte selectors or Station mentions, so it is not a verbatim bundle copy.
- The production image copies `public/` (fonts included); only the test stage adds `scripts/`.
- The in-repo `docs/OPUS-REVIEW-2026-11-03.md` contains no capability-like hex keys.

**Non-blocking notes.**

- `/recipes`, `/about`, `/privacy` and `/license` now take precedence over the curl/wget missing-path receive fallback, so a CLI receive for files with those exact names is no longer possible through that shortcut.
- `index.html` has a static footer year.
- Latin-only font subsets render Devanagari and emoji filenames in system fallback fonts, as on the reference.
- I did not verify pixel parity myself (no Chrome). It rests on root's live Chrome computed-style comparison.

**Verdict.** **No new P0 or P1.** The UI correction keeps the previously accepted runtime, security and role-isolation properties. **Final acceptance stands.**

## FINAL ACCEPTANCE (restored) — nginx header-buffer fix

**Files inspected.**

| File | Hash |
| --- | --- |
| `deploy/nginx.conf` | `27BD068F206A` |
| `compose.smoke.yaml` | `29E88396E15F` |
| `scripts/proxy-smoke.ts` | `645C0BF8C42F` |
| `.github/workflows/ci.yml` | `5C4FF1EBD57C` |

The runtime files are byte-identical to the versions already reviewed: `server.ts` `7A555603875B`, `http-server.ts` `07294D03145B`, `admission.ts` `D74AA7E900D8`.

**P1-F is resolved.**

- **nginx settings.** `deploy/nginx.conf` sets `proxy_buffer_size 64k; proxy_buffers 4 64k; proxy_busy_buffers_size 128k;` (valid: 64k ≤ 128k < 4×64k − 64k = 192k). Body buffering stays off (`proxy_buffering off`, `proxy_request_buffering off`). 64k covers the measured 25–26.5 KB worst case. With response buffering off, nginx allocates only the 64k header buffer per proxied request.
- **Smoke test** (`compose.smoke.yaml` + `scripts/proxy-smoke.ts`):
  - publishes no host ports and waits for `/healthz` through the proxy;
  - uses a long `PUBLIC_URL` host (network alias to the proxy) and a filename of exactly 1,024 UTF-8 bytes (Hindi);
  - asserts the entry `307`, the largest header block (QR rows plus seven filename-bearing URLs), including `com.station307.human.transfer.url` equal to the download URL;
  - hash-checks a 2 MiB+19 transfer through nginx, including the `Content-Disposition` name;
  - asserts the prepared `201`, then hash-checks a 3 MiB+17 stdin upload;
  - cleans up its processes and temp directory.
  CI runs it on Linux with `--exit-code-from smoke` and always tears the stack down.
- **[V-parent]** On nginx 1.29.8: a 26,529-byte header block, the CLI `307`, and both transfers with exact SHA-256; the smoke exited 0.
- Remaining minor gap, not a blocker: the smoke doesn't itself hold a sender waiting for 5 s or more, or hit receive-first `GET /xfr`. Both have similar header sizes and were proven separately on the deployed nginx.

**Final verdict.** **Accepted for a tested desktop and self-hosted release.**

- Every P0 and P1 from all review passes is fixed and verified: initial P0s, P1-1 to P1-6, A–D, E (gateway trust) and F (nginx header buffer).
- These P2 trade-offs remain documented:
  - collapsed-source deployments share budgets;
  - IPv6 /48 holders get many per-/64 quotas;
  - the stored quota id is an unsalted IP hash (disclosed);
  - a reused sender URL prefers the stored size;
  - there's no frontend `PUBLIC_URL` safety net.
- Unverified, not claimed as tested: physical Android or iOS, Safari, public ACME, and an Indian host or WAN benchmark.

## ALIAS CHECK — Station CLI header aliases (`server.ts` `7A555603875B`)

> **Superseded:** P1-F below was resolved by the nginx buffer fix and proxy smoke test; see FINAL ACCEPTANCE above.

**Scope.** The only change since v6 is in `cliHeaders()`. A `transfer` variable holds the same expression as the existing `com.station307.transfer.url`. Three aliases now reuse it: `com.station307.human.transfer.url`, `com.station307.url` and `com.station307.located-at`.

**Capability check: sound [V-cur code].**

- The headers are emitted only by `cliEntry` (to the channel creator) and `replayUpload` (to the sender).
- In receive-first, the upload URL goes to the creating receiver, who already gets it in `x-airshare-upload-url`. In send-first, the download URL goes to the sender.
- Receiver downloads, pages and status never use `cliHeaders`.
- Header names are valid tokens and values are ASCII.

**P1-F — the CLI header block exceeds nginx's default `proxy_buffer_size` [V-cur].**

- **nginx's limit.** A stock `nginx:1.29-alpine` proxy with `proxy_buffering off` returned `307` for an upstream 307 with about 3.3 KB of headers. At about 3.9 KB it returned `502` with "upstream sent too big header". The default is one 4 KiB page.
- **AirShare's actual upstream header bytes for CLI 307s:**

| Case | Now | Before the aliases |
| --- | --- | --- |
| Origin `localhost:3080`, `report.pdf` | 3,686 | 3,376 |
| Origin `airshare.mydomain.co.in` (QR grows to 23 rows), `report.pdf` | 4,226 | ≈3,900 |
| 180-character ASCII name | 4,845 | 4,022 |
| ≈30-character Hindi name | 5,342 | 4,324 (already over) |
| Maximum-length Unicode name | 25,040 | 15,568 |

- **Effect.** Through `deploy/nginx.conf`, which sets no `proxy_buffer_size`, CLI sends and receive-first entries on moderately long domains now get `502`. Hindi-named CLI sends already failed before this change. The deployed tests used the short `localhost:3080` origin, so they couldn't catch it. Caddy (Go, 10 MB header limit) and direct connections are unaffected.
- **Fix.**
  - In the nginx location, set `proxy_buffer_size 32k; proxy_buffers 4 32k; proxy_busy_buffers_size 64k;`, and document this for custom nginx setups.
  - Optionally drop the filename segment from header transfer URLs.
  - Regression: through compose nginx, a long `PUBLIC_URL` plus a maximum-length Hindi CLI send returns `307`, and the transfer hash matches.
- **Acceptance.** Withdrawn only for the bundled-nginx CLI path until this lands. Every other accepted item stands.

## ACCEPTANCE — gateway-trust fix rechecked against the live working tree

**Files read directly.**

| File | Hash |
| --- | --- |
| `compose.proxy.yaml` | `7AC591DE0B0D` |
| `compose.https.yaml` | `DCFB43F71822` |
| `compose.yaml` | `732AB0BC65A8` |
| `README.md` | `BE95ACEE67B5` |

**P1-E is resolved [V-cur config].**

- Both overlays assign the proxy (nginx or Caddy) a static `ipv4_address` of `${AIRSHARE_PROXY_IP:-172.28.240.10}`, inside the fixed `${AIRSHARE_NETWORK_CIDR:-172.28.240.0/24}` network.
- `TRUSTED_PROXIES` defaults to `${TRUSTED_PROXIES-${AIRSHARE_PROXY_IP:-172.28.240.10}}`, a single address. `admission.ts` parses a bare address as an exact match, so the bridge gateway (`.1`) is never trusted.
- With that default, the right-most untrusted `X-Forwarded-For` entry is always the address the proxy itself appended: the real client, or the gateway on setups that collapse sources. Client-chosen prefixes can no longer select the identity.
- The backend keeps `ports: !reset []` in both overlays.
- README lines 59, 194, 196 and 198 document the static proxy address, exact-IP trust for other proxies, shared budgets under Docker Desktop, rootless Docker, IPv6 userland proxying and carrier NAT (with an explicit warning not to broaden trust), and the nginx 1.29+ `early_hints` or Caddy requirement.
- **[V-parent]** On the deployed nginx at `.10`, with backend `TRUSTED_PROXIES=172.28.240.10`, 35 POSTs with rotating forged `X-Forwarded-For` got exactly 30×`201` and 5×`429 creation_rate`. A new black-box regression covers an untrusted gateway with forged prefixes.

**Residual (P3, not a defect).** Docker allocates dynamic addresses from the whole subnet. If an operator adds services, one could take `.10` before the proxy starts. That fails closed (the proxy won't start) rather than open. An `ip_range` such as `172.28.240.128/25` would keep dynamic allocations away from the reserved address.

**Final verdict.** **Accepted for a tested desktop and self-hosted release.**

- All P0 and P1 findings from the initial, final and scoped reviews are fixed and verified (A–D and E).
- These P2 items remain as documented trade-offs, not blockers:
  - collapsed-source deployments share budgets;
  - IPv6 /48 holders get many per-/64 quotas;
  - the stored quota id is an unsalted IP hash (disclosed);
  - a reused sender URL prefers the stored size;
  - there's no frontend safety net for a wrong `PUBLIC_URL`.
- Explicit verification limits, not represented as tested: physical Android or iOS, Safari, a public ACME certificate, and an Indian host or WAN benchmark.

## FINAL VERDICT — current tree, snapshot v6 (`%TEMP%\airshare-opus-final-v6-135046`, 13:50)

> **Superseded:** P1-E below was resolved by the static-proxy fix; see ACCEPTANCE above.

**Files reviewed.**

| File | Hash |
| --- | --- |
| `server.ts` | `6E10213B1F9B` |
| `http-server.ts` | `07294D03145B` |
| `admission.ts` | `D74AA7E900D8` |
| `metadata-store.ts` | `1FB4ADB40A9F` |
| `config.ts` | `F523F934C6DF` |
| `compose.proxy.yaml` | `127D8DB97E26` |
| `compose.https.yaml` | `7521D995996F` |

**Runtime checks.** Private port 47421, now stopped, plus one throwaway Docker network and container (`opus-srcip-*`), since removed.

**Verdict.**

- **Functionally**, AirShare now delivers the requested Station307 workflows with AirShare branding:
  - browser sharing, two receivers, reload and resume;
  - curl and wget hosting until stopped;
  - receive-first transfers;
  - prepared stdin pipes;
  - empty files, Unicode names and files over 128 MiB;
  - multiple receivers;
  - QR codes, persistence, and TLS through Caddy.
  Every P0 and P1 from both earlier review passes is fixed and verified.
- **Not ready for an Internet-facing deployment** using the shipped `compose.proxy.yaml` until one config default changes: **P1-E** below. It is a one-line class of fix. A LAN or private deployment is not affected.

### Status of A–D (all fixed)

- **A** — liveness probe. **[V-cur]** Direct curl `-D -` printed exactly 4 `HTTP/1.1 103` blocks (`Link: </healthz>; rel=monitor`) in a 16 s wait, at 1, 3, 7 and 15 s, backing off to 30 s. The receiver then got 2 MiB with matching SHA-256. **[V-parent]** GNU wget through the rebuilt nginx with a 5.5 s wait, and Caddy HTTPS/HTTP/2 with a 5.5 s wait, both exact. **[I]** nginx 1.29+ forwards or skips 103 (`early_hints 1`); wget skips 1xx.
- **B** — continuous-unprotected TTL. **[V-cur]** With a 3 s TTL: hosting past the TTL → 200; 300 ms after the sender drops → 200; after 3.9 s continuously unprotected → 404. `lastProtectedAt` is persisted, and transitions are hooked (SSE, tracker, waiting receiver, upload end, presence 0, shutdown).
- **C** — overlays use a fixed network and the backend has no published ports. Default trust breadth: see E.
- **D** — **[I]** 256 live channels per client (`MAX_CHANNELS_PER_CLIENT`), counted from persisted creator ids and released on close. Single-IPv4 slow lockout is closed.

### Remaining findings

**P1-E — the default `TRUSTED_PROXIES` trusts the whole compose subnet, including Docker's bridge gateway, so client identity can be spoofed through the bundled nginx [V-cur logic + V-cur Docker observation].**

- **Docker observation.** On this Docker Desktop 29.7.2, an nginx container on a /24 network logged the host-published client as the network gateway `172.28.250.1`, while a client-supplied `X-Forwarded-For` passed through. Rootless Docker and Docker's userland proxy (used for IPv6 clients into IPv4 containers) rewrite sources the same way.
- **What reaches AirShare.** nginx's `$proxy_add_x_forwarded_for` sends `client-chosen, 172.28.240.1`. `admission.ts:42` walks past trusted entries, and the gateway is inside the default `172.28.240.0/24`, so the client-chosen value becomes the identity.
- **Proof with the real admission code** (`TRUSTED_PROXIES=127.0.0.0/8`, `127.0.0.2` as the gateway hop): the control case gave 30×`201` then 5×`429`; with the trusted gateway hop, 35×`201` and no limiting.
- **Impact.** Creation admission, the per-client channel quota, and the receiver, SSE and discard caps can all be bypassed. Caddy discards untrusted `X-Forwarded-For`, so it can't be spoofed, but affected clients collapse into one shared bucket.
- **Fix.**
  - Give the proxy a static address and trust only that /32 by default.
  - Document that Docker Desktop, rootless Docker and IPv6 through the userland proxy don't preserve client IPs. Use host networking for the proxy, or Docker IPv6 with `ip6tables`.
  - Add a regression: with the /32 trusted and `XFF: chosen, gateway`, the identity is the gateway.
  - README line 59 currently says the overlays "trust that network".

**P2 (document or accept):**

- 103 interim responses break behind nginx older than 1.29, the usual distro version (it treats any non-103-aware 1xx as final). The README never states "nginx ≥ 1.29 with `early_hints`, or Caddy". Consider a `LIVENESS_HINTS=0` switch.
- The quota id is an unsalted SHA-256 of the client IP or /64 (disclosed in README line 5), which is reversible for IPv4. Use a per-install HMAC key, or keep counts in memory only.
- IPv6 /48 holders get many per-/64 quotas, and users behind CGNAT share IPv4 buckets. Both are documented trade-offs; the server should be reachable over IPv6 for Indian mobile users.
- A reused sender URL still prefers the stored size over the request's own `Content-Length`.
- There is no frontend safety net for a wrong `PUBLIC_URL`; this is documented.

**Verification limits that remain.**

- No Android, iOS or Safari device testing.
- No public ACME certificate, Indian host, or WAN benchmark.
- Real Chrome checks were run by the parent, as recorded in the AUDIT doc. I ran no browser.
- The AUDIT "Final status" section is still a placeholder.

## 0. Scoped re-review of the final fix wave (supersedes the status in sections 2, 3 and 8)

**Snapshots.**

- v4 (`%TEMP%\airshare-opus-final-v4-132319`):
  - `server.ts` `1E352C6BA1E9`
  - `http-server.ts` `26F705DA19AC`
  - `admission.ts` `D74AA7E900D8`
  - `transfer.js` `9805AFA1298F`
- v5 (`%TEMP%\airshare-opus-final-v5-133404`):
  - `server.ts` `75DB9C3232F3`
  - `nginx.conf` `9BC1E7DB9702`
  - `http-server.ts` unchanged from v4

**Runtime checks.** Run on v4 using private ports 47411 and 47412, which are now stopped. Labels follow section 1.

**Verdict.** Not yet "ready to deploy" for a public instance. The original six P1s are fixed or substantially fixed. The fix wave introduced or exposed four P1 items (A–D below); each has a small, concrete fix.

### 0.1 Original P1s: disposition

| P1 | Status | Evidence |
| --- | --- | --- |
| P1-1 receiver cancel ends hosting | **Fixed** | **[V-cur]** Real curl, 8 MiB, receiver 1 cancels at 1 MiB → curl keeps hosting (`307`, `100`, `307` replay) → receiver 2 gets 8,388,608 bytes with matching SHA-256. **[I]** The browser `HostSession` uses a per-attempt `x-airshare-upload-id`, classifies retryable departures (`409`/`408` plus reason), reclassifies a transport error only from a matching `lastUploadId`, retries with 0.5–5 s backoff, and clears recovery on pause, suspend, dispose or close. Real-browser execution not verified. |
| P1-2 abandoned uploads drained in full | **Fixed (server)** | **[V-cur]** A browser-style uploader kept sending after its only receiver left. It got `409 {"reason":"no_receivers","retryable":true}` with `connection: close` at 105 ms, the socket closed at 106 ms, and only 37 MiB were sent. Owner status carries `lastUploadId` and retryable, with no `lastError`. Bounded drain is 1 MiB or 250 ms. Initial-307 eager discards are capped (64 global, 8 per client). |
| P1-3 one client locks out creation | **Fast path fixed; slow path open (D)** | **[V-cur]** Same address: 30×`201`, then `429` with `Retry-After: 2`; another address: `201`. Unused, unprotected channels are evicted at capacity. |
| P1-4 floods collapse live throughput | **Fixed in code** | `PRAGMA synchronous=NORMAL`, prepared statements, `used_at` column. Re-measurement is owned by the load agent; no new number from me. |
| P1-5 stdin through a proxy truncates | **Fixed** | **[V-parent]** Prepared 3 MiB+17 stdin through nginx: exact SHA-256. Unprepared: `411`, no `307`. **[I]** Code: unknown-length entry bodies always get 411; the prepare step stores no size. |
| P1-6 no per-client caps | **Fixed in code; behind proxies see C** | Per client: 128 receivers, 64 SSEs, 8 discards (64 global), all released on every path reviewed. |

Also fixed:

- Station tracker ping is now 5 s (native SSE stays 15 s).
- The wget form type is fixed on both entry and upload (v5 `server.ts:383-389`).
- Metadata errors no longer fail waiting receivers (v5).
- nginx: 24 h timeouts, per-IP `limit_req` and `limit_conn`, `access_log off`.
- A Caddy TLS example was added.
- `Referrer-Policy` and `X-Frame-Options` added (v5).

### 0.2 Remaining load-bearing findings

**A — P1, 1xx liveness probe vs proxies and the CLI [V-cur direct, I proxy].**

- `http-server.ts:155-160` sends `HTTP/1.1 102 Processing` every second whenever an upload body hasn't been pulled for at least 1 s. That covers every hosting wait and every multicast pause of 1 s or more.
- **nginx.** nginx's proxy module (master, the 1.29 103 support) loops back to the status line only for `103`. It notes "no 1xx since we don't send Expect and Upgrade", so a `102` is taken as the *final* upstream response. The real response would then be forwarded as raw body bytes on a keep-alive connection that never closes. That breaks framing for any sender behind the bundled nginx that waits at least 1 s; on HTTP/2 it is a protocol error.
- **Mid-switch state.** v5 adds `early_hints 1;` to `nginx.conf` ("103 liveness hints"), but the transport still emits `102`. The repo is part-way through switching probes.
- **curl.** Direct curl (verified): `curl -D -`, which the README hosting recipes use, printed 5 `HTTP/1.1 102` blocks in the first 6 s, about one per second. The share URL and 21 QR rows scroll away during any wait.
- **wget.** GNU wget skips any 1xx (source: `H_10X` → "Ignoring response"), so direct wget is fine.
- **Caddy.** Go's transport (current) no longer caps the number of 1xx responses, and forwards them.
- **Required before calling it ready:**
  - pick 103 (with nginx `early_hints`) or no 1xx at all;
  - probe at most every 15–30 s, and only while waiting for the first byte to be pulled, never during an active multicast;
  - prove it through compose nginx and Caddy with a sender waiting at least 5 s before the receiver (curl, wget and an HTTP/2 browser upload), with SHA-256 checks and a later 307 replay.

**B — P1, unused-channel expiry counts from creation [V-cur].**

- `expired()` (`server.ts:115-117`, v5 unchanged) uses `createdAt` for channels that have never been used.
- Repro with `UNUSED_CHANNEL_TTL_MS=3000`: host through native SSE `?hosting=1` past the TTL (status still 200). Drop the SSE; a receiver status poll 300 ms later returns `404`, and the share is permanently gone.
- With the 5-minute default, any share older than 5 minutes that hasn't completed a transfer dies on the first lookup or cleanup during a sender gap. Gaps come from EventSource reconnect (about 3 s), network handover, laptop sleep, or a restart before the sender reconnects. Receiver pages poll every 2 s, so the window is found quickly.
- That breaks "share now, receiver opens later".
- Fix: track `lastProtectedAt` and expire unused channels only after `UNUSED_CHANNEL_TTL_MS` of being *continuously* unprotected; set it at load time after a restart. Spam channels never gain presence, so they still expire 5 minutes after creation.

**C — P1 for the documented proxy deployments, out of the box [I].**

- `compose.proxy.yaml` and `compose.https.yaml` default `TRUSTED_PROXIES` to empty, and the README's HTTPS command doesn't set it.
- Every per-client cap therefore becomes service-wide, shared by all users through the proxy: 30 creations per minute, 128 receivers, 64 SSEs, 8 discards. One client can exhaust each of them. Caddy has no per-IP limit of its own in this config.
- README line 191 documents the creation case only.
- Fix: give the compose network a fixed subnet and default `TRUSTED_PROXIES` to it in both overlays. Document that receiver, SSE and discard caps are also shared without it.

**D — P1 for public instances, slow single-address persistent lockout [I].**

- Used channels (`usedAt` set, or `completedTransfers > 0`) are never evicted at capacity and live 24 h from their last touch. Any lookup touches a channel.
- One address at 30 creations per minute can make each channel "used" with a 0-byte self-transfer, filling 10,000 channels in about 5.6 h. Every new creation then gets `503` for as long as the attacker polls those channels.
- Fix: a per-client live-channel quota (for example 100–500, keyed like admission), LRU eviction of idle unprotected channels at capacity, and/or a larger default `MAX_CHANNELS`. IPv6 attackers with many /64s can do this faster; consider a /48 aggregate.

### 0.3 Remaining P2 and P3

- **Stored size wins over the upload's own length.** `uploadMetadata` (v5 `server.ts:383`) prefers the stored channel size over the request's `Content-Length`, so a sender URL reused for a file of a different size fails with `400`. Prefer the explicit header, then the request's own length.
- **No `PUBLIC_URL` safety net in the frontend.** Server URLs are absolute; this is documented, but there's no browser fallback.
- **CGNAT.** IPv4 CGNAT users (common on Indian mobile networks) share per-client buckets. Serve over IPv6 (an AAAA record) so mobile users are keyed per /64, and document this.
- **Real-browser testing still missing.** No desktop or Android Chrome end-to-end run yet; frontend tests stop at the DOM, XHR and EventSource boundary.
- **AUDIT doc.** The "Final status" placeholder is still to be filled from the final run.

### 0.4 What must happen before "ready to deploy"

1. Resolve A, with proxy proofs (nginx and Caddy) of a waiting sender.
2. Fix B with a regression: host past the TTL, briefly disconnect, reconnect, and the share survives.
3. Fix C: compose subnet plus default `TRUSTED_PROXIES`.
4. Fix or explicitly accept and document D.
5. One real-browser end-to-end pass:
   - 2 receivers;
   - a cancel, then the next receiver is served;
   - reload, then resume;
   - a Unicode name;
   - more than 128 MiB;
   - through Caddy HTTPS.

## 1. What was reviewed, and how to read the evidence labels

| Item | Value |
| --- | --- |
| Baseline | `64e8756` (initial release) |
| Branch | `codex/station307-parity-audit` (uncommitted working tree plus untracked files) |
| Snapshot v2 (server marked ready) | `%TEMP%\airshare-opus-final-v2-125611` |
| Snapshot v3 | `%TEMP%\airshare-opus-final-v3-130345` |
| `src/server.ts` | `246820A53C4F…`, identical in v2 and v3 |
| `src/http-server.ts` | v2 `511B6A5056AC`; v3 `708C0F94D473`; repo at report time `48C271E7671A` (reviewed) |
| `public/transfer.js` / `app.js` / `sender.js` / `receiver.js` | `B333BED36F19` / `BEC84BC3050A` / `AF52DB2FEE89` / `24C373CC8098`, unchanged v2→v3 |
| `src/metadata-store.ts` / `src/config.ts` / `src/qr.ts` | `9B7771D9147D` / `F7F8B4985F9B` / `A108647E9DF0` (QR later fixed by root; not re-reviewed) |
| Environment | Windows, Bun 1.4.0, Node 26.13.0, curl 8.21.0. GNU Wget and the nginx/Docker probes were run by the parent, not by me |

Evidence labels used below:

- **[V-cur]** reproduced against code that is still current at report time.
- **[V-v2]** reproduced on snapshot v2. The relevant code is unchanged in the current tree unless the finding says otherwise.
- **[V-parent]** reproduced by the parent or another agent; I reviewed the reported evidence but did not rerun it.
- **[I]** inferred from code, specifications or vendor documentation; not executed.
- **[S]** stale: an initial-review finding now fixed in code (and usually in tests).

A fix wave was in progress while this report was written: retryable cancellation, creation admission and rate limits, a short TTL for unused channels, SQLite `synchronous=NORMAL`, bounded drain for abandoned uploads, a 5 s tracker heartbeat, the stdin entry policy, and the QR quiet-zone fix. Findings that this wave addresses are marked **fix pending**. They still need a scoped re-review against the final diff.

## 2. Verdict

The rewrite resolves every P0 from the initial review: arbitrary file read, capability confusion, the 128 MiB limit, Unicode filenames crashing downloads, and TLS-proxy URLs. Most P1 and P2 items are resolved too, and they are covered by real-HTTP tests. The transport is sound:

- streamed `Content-Length` is preserved;
- each receiver's queue is bounded;
- `Expect: 100-continue` is only acknowledged when the handler actually reads;
- long idle waits survive;
- request framing is correct.

**It is not yet ready to deploy publicly.** Six load-bearing issues remain:

- one receiver's cancellation ends hosting;
- abandoned uploads are drained in full;
- one client can lock out all channel creation, and the lockout survives restarts;
- request floods collapse live throughput;
- piped stdin through the bundled proxy silently corrupts the delivered file (confirmed by the parent);
- global connection caps have no per-client share.

Each has a concrete fix, and most fixes are already in progress (section 3). Real-browser end-to-end verification is also still missing.

## 3. Findings (prioritized)

### P1-1 — One receiver cancelling or stalling ends hosting **[V-v2 CLI, I browser; fix pending]**

- **CLI repro.** Run `curl -T big.bin -L …/xfr/big.bin` with a 64 MiB file. Receiver 1 closes after 8 MiB. curl saw `307`, then `100 Continue`, then `409 Conflict`, and **exited 0**. A second receiver was **not served within 6 s**.
- **Server cause.** `failReceiver` turns an emptied receiver set into `HttpError(409, "All receivers disconnected")` (`server.ts:277`). The `handleUpload` catch returns JSON 409/408/410 with no `Location` (`server.ts:445-453`), so curl's 307 hosting loop ends.
- **Browser cause [I].** `HostSession.maybeUpload` stores `error.message` for every failure that isn't an abort (`transfer.js:287-290`). Its guard returns early while `this.error` is set (`transfer.js:268`). Hosting therefore halts until the sender clicks Retry. Meanwhile new receivers see "Ready to download", because `senderOnline` stays true through the `hosting=1` SSE.
- **Fix (agreed design).**
  - Classify `no_receivers` and `receiver_stalled` as retryable.
  - Answer a known-length CLI upload with 307 back to its sender URL.
  - The browser keeps hosting, backs off, and treats an XHR network error after a server abort as retryable once a status refresh succeeds.
  - The existing test "explicit retry … without an automatic retry loop" must change for retryable reasons.
  - Regressions: receiver 1 cancels or stalls, then receiver 2 completes with a matching SHA-256, for both real curl and the `HostSession` boundary test.

### P1-2 — Abandoned active uploads are drained in full **[I on current adapter; V-v2 for the predecessor; fix pending]**

- **v2 [V-v2].** A 512 MiB upload whose only receiver quits at 32 MiB returned `409` with `connection: keep-alive`. The body was paused, not drained: the uploader stayed at 37 MiB and hadn't moved 4 s later. That left a zombie connection for clients that keep sending, because `cancel()` set `bodyEnded` and skipped `connection: close`.
- **Current adapter `48C271E7671A` [I].**
  - `cancel()` now sets `bodyCancelled`.
  - `endResponse` (`http-server.ts:180-192`) flushes headers, then awaits a **full** discard of any unread body that wasn't sent with Expect before calling `end()`.
  - The discard is bounded only by `MAX_REQUEST_BODY_SIZE` (unlimited by default) and a 30 s idle timer that resets on every chunk.
  - Effect: a browser host whose receiver cancels keeps uploading the remaining gigabytes. Its XHR can't complete until then, so the next receiver waits for the whole remaining upload.
  - A client trickling bytes holds a socket indefinitely, which amounts to a body slowloris.
- **Fix.**
  - Mark abandoned *active* uploads for a short bounded linger, a few MiB or seconds, then close. Keep full streaming discard only for the initial eager-wget 307.
  - Bound discards by bytes, duration and concurrency.
  - The browser host should abort its own XHR once status shows its upload generation ended; a per-upload id in status avoids the startup race.

### P1-3 — One client can lock out channel creation, and the lockout survives restarts **[V-v2; fix pending]**

- **Measured.** One client made 9,999 creations in **11.5 s** (concurrency 50). A legitimate create then got `503 Channel capacity reached; retry after unused channels expire`. After restarting on the same `DATA_DIR`, creation was **still 503**, because the channels are persisted and reloaded (`server.ts:96`).
- **Cause.** `createChannel` refuses at `MAX_CHANNELS` (`server.ts:115-117`) with no per-client admission. Never-used channels live the full 24 h TTL, and receiver polling extends it because `lookup` calls `touch` (`server.ts:104-111`).
- **Creation is unauthenticated through many routes:** `POST /api/channels`, `POST /api/v1/channel`, any generic `POST`/`PUT`, and any curl or Wget `GET` of `/` or a missing path (`server.ts:638-647`).
- **Fix design concerns (sent to `server_reliability`).**
  - Behind the documented nginx proxy, keying on socket `remoteAddress` makes **one shared bucket**. Add an opt-in trusted-proxy setting using `X-Real-IP` or the right-most untrusted `X-Forwarded-For`, and set those headers in `deploy/nginx.conf`.
  - Key IPv6 clients by /64.
  - Evict buckets (LRU) instead of refusing when the bucket map is full.
  - The 5-minute unused TTL must exempt channels with waiting receivers (receiver-first waits can be long) and channels with a hosting sender present. `expired()` (`server.ts:103`) currently exempts only `channel.upload`.
  - Persist a "previously used" marker so used channels aren't reclassified as unused after a restart.

### P1-4 — Request floods collapse live throughput; creation costs the most **[V-v2]**

All runs use one 2 GiB transfer to one receiver on loopback.

| Load | Live throughput before | Live throughput during |
| --- | --- | --- |
| Creation spam (≈ 870 req/s) | 279 MiB/s | **15.9 MiB/s** |
| Status `GET` spam (4,163 req/s, no writes) | 284 MiB/s | 72 MiB/s |

No receive gap exceeded 100 ms, so this is throughput collapse, not a hang. Per request, creation costs about **6×** more than a status read. The likely causes are a synchronous `bun:sqlite` insert on the event loop with SQLite's default `synchronous=FULL` in WAL mode (`metadata-store.ts:28-33`), plus JSON handling.

**Fix.**

- Set `PRAGMA synchronous=NORMAL` (planned).
- Add creation admission (planned).
- Coalesce `touch()` persists.
- Document that one event loop serves every stream, so rate limiting at the proxy matters.

### P1-5 — Piped stdin through the bundled nginx silently corrupts the delivered file **[V-parent; fix pending]**

- **Parent repro.** A 3 MiB pipe through compose and nginx: `curl -T - -L -D - …/xfr/synthetic-pipe.bin` exited 0 after statuses `100, 307, 100, 200`. The receiver got `200` with **1,900,772 of 3,145,728 bytes** and a **SHA-256 mismatch**.
- **Cause [I].** nginx answers `100 Continue` itself as soon as it starts proxying an upload. curl therefore streams stdin into the initial `/xfr` request, which AirShare answers with 307 without reading. The redirected request carries only the rest of the pipe.
- **Why receivers can't detect it.** Unknown-length downloads have no length to check, so the result looks like a successful transfer. Direct connections pass only because Bun's `checkContinue` path defers `100 Continue`.
- **Ruling (sent to the parent).** Put integrity first:
  - Entry routes must never 307 a body that may already be streaming and can't be replayed. Reject unknown-length entry bodies with **411 Length Required** and a ready-to-run two-step command. A proxy that already answered `100 Continue` can't be detected, because nginx may or may not forward `Expect`.
  - Offer an explicit opt-in (for example `ALLOW_STDIN_REDIRECT=1`) for proxyless direct installs.
  - Document a two-step flow that is safe behind proxies: prepare, then `curl -T -` to the sender URL with no redirect. Include a POSIX one-liner using `-w '%header{x-airshare-upload-url}' -o /dev/stderr`, and a PowerShell **7.4+** variant (Windows PowerShell 5.1 corrupts binary native pipes).
  - Optionally, experiment with a single-request stream that announces the URL via `103 Early Hints`, gated by a proxy test.
  - Document that unknown-length streams can't reveal an early-stopping producer. Recommend self-verifying formats, checksums, or `x-airshare-file-size` when the size is known.
- **Pitfall to avoid in the two-step flow.**
  - `cliEntry` stores `contentLength` from the creating request's own `Content-Length` (`server.ts:505`).
  - `uploadMetadata` prefers the stored size over this request's size (`server.ts:352`).
  - So a prepare request with `Content-Length: 0` would make a later chunked upload fail with "Upload exceeds its advertised file size".
  - Prepare must not record a size. Uploads should prefer the explicit header, then the request's own `Content-Length`, and treat the stored size as advisory.

### P1-6 — Global connection caps have no per-client share **[I]**

- **Exposure.** `MAX_RECEIVERS` (4096), `MAX_SUBSCRIBERS` (4096), and the unbounded drain or discard sockets can each be filled by one client. That client only needs waiting downloads on its own channels, `/api/v1/track` SSEs, native status SSEs, or trickled discards.
- **Effect.** Everyone else then gets `429`. Browser status degrades to polling, but downloads and Station-style tracker clients fail. Waiting receivers deliberately have no idle timeout, so held sockets are cheap for an attacker.
- **Fix.** Track concurrent receivers, SSEs and discards per client key under the same admission design as P1-3. Document `ulimit` and proxy connection limits.

### P2 findings

1. **`PUBLIC_URL` misconfiguration breaks browsers silently [I].**
   - Without `PUBLIC_URL` behind TLS, payload URLs are `http://` (`server.ts:48`, `56-69`). Chrome blocks insecure downloads and mixed-content XHR and EventSource from `https` pages.
   - Add a safety net: the frontend rewrites same-host absolute URLs to `location.origin`, or browser payloads use relative URLs. Also log a startup warning, and report the public origin in `/healthz` or startup logs.
2. **Monitors create channels [I].** curl or Wget probes of `/` or a missing path create channels (`server.ts:639`, `642-647`). Docs should send monitors to `/healthz`; the Dockerfile health check already does. The short unused TTL plus admission bound the impact.
3. **nginx example timeouts and TLS [I].** `proxy_read_timeout 1h` and `proxy_send_timeout 1h` cut idle CLI hosts and receivers waiting over an hour; raise them (for example 24h) or document the limit. There's no TLS or HTTP/2 example even though the README says to use HTTPS; add a Caddy or certbot example. Note that a Cloudflare proxy caps uploads at 100 MB on Free/Pro and returns 524 after 125 s without headers (Cloudflare docs, checked during the initial review). Advise a DNS-only transfer hostname.
4. **wget double upload [V-parent behavior, I cost].** wget doesn't use `Expect`, so its whole body goes to the initial 307 and is discarded, then re-posted. That doubles upload time. Document a two-step wget recipe, and bound discards (P1-2).
5. **wget form content type [I].** wget's form type `application/x-www-form-urlencoded` becomes the file type (`server.ts:505`, `354`), so receivers get that type. Map form and multipart types to `application/octet-stream`, or infer the type from the extension.
6. **Station tracker heartbeat [V-parent; fix pending].** Station's client deadline is 10 s while AirShare's tracker ping is 15 s (`server.ts:192-199`, `233`). The fix moves the tracker to 5 s.
7. **Waiting receivers killed on metadata errors [I].** Any upload metadata error fails *all* waiting receivers (`server.ts:422-426`). Only the sender can trigger it now, but a bad retry shouldn't strand receivers that could wait for a corrected upload.

### P3 findings

- Hardening: CSP, `Referrer-Policy: no-referrer`, `frame-ancestors`, and moving the inline `window.STATION_CHANNEL` bootstrap into a JSON data element so `script-src 'self'` works.
- Status polling every 2 s for each share beyond 3 SSEs, and for each receiver tab, should back off when idle.
- Capability keys sit in plaintext in SQLite (documented). Consider deriving the sender and receiver keys from a stored secret, or encrypting at rest, if the volume may be exposed.
- The README uses `/xfr/name` while the homepage recipes use `/name`. Both work; pick one.
- The `docs/AUDIT-2026-11-03.md` "Final status" section is a placeholder. Its parity rows "Regular-file CLI hosting until stopped" and "Piped … one-shot" over-claim until P1-1 and P1-5 land. Line 31 ("Persistent error state …") is the cause of the browser half of P1-1.
- `com.station307.*` header names are kept for compatibility. That's acceptable as protocol aliases, but the branding trade-off should be stated.

## 4. Initial-review findings: current status

| Initial finding | Status | Evidence |
| --- | --- | --- |
| Static arbitrary file read | **[S] fixed** | `serveStatic` decodes, rejects `\` NUL `:` `//` `..`, resolves under `publicRoot`, checks `realpath` containment and `isFile` (`server.ts:540-551`). Tests: encoded Windows separators. |
| Receivers could upload, delete or escalate | **[S] fixed** | Role-checked `lookup` on every native and Station route; receiver payloads omit `uploadUrl` and `deleteUrl` and expose the receiver key as `id`; Station details redacted by role (`server.ts:56-88`, `104-111`, `589-636`). Tests: forgery and leaks. |
| 128 MiB body limit | **[S] fixed** | `node:http` adapter with a configurable ceiling; JSON metadata capped at 16 KiB, including chunked bodies (`server.ts:147-168`). Tests: over 128 MiB with hash checks. |
| Unicode filenames → 500 and stranded peers | **[S] fixed** | ASCII fallback plus `filename*`; control and bidi filtering; length bounds (`server.ts:123-141`, `252-256`). |
| `http://` URLs behind TLS | **[S] fixed via `PUBLIC_URL`** | Residual safety net: P2-1. |
| Development error page leaked source | **[S] fixed** | Controlled JSON errors (`server.ts:653-666`); `NODE_ENV=production`. |
| Stalled receiver froze everyone forever | **[S] fixed** | 120 s stall eviction (configurable); everyone still pauses during the window (documented). |
| curl send lost the filename; one-shot hosting | **[S] fixed** | `/xfr/name` or `/xfr/`, 307 replay, `--max-redirs -1`. Residual: P1-1. |
| Receiver-first wrong metadata | **[S] fixed** | Response stays pending until the upload's immutable metadata (`server.ts:280-285`, `305-325`). |
| Bun dropped streamed `Content-Length` | **[S] fixed** | `node:http` adapter preserves framing. |
| Unbounded channel leak | **[S] bounded** | TTL plus cap, but the cap became a lockout (P1-3). |
| One SSE per shared file | **[S] fixed** | At most 3 SSEs per page plus polling; receiver pages poll. |
| Hardcoded localhost recipes; clipboard on HTTP | **[S] fixed** | `{{origin}}` recipes; `execCommand` fallback. |
| All receivers gone → full drain and false success | **[S] partially fixed** | The upload now aborts with 409; drain behavior is P1-2. |
| Empty files failed | **[S] fixed** | Zero-byte path in `handleUpload` and `pump`. |
| Size stuck after first upload | **[S] mitigated** | The browser sends the explicit size. CLI and two-step pitfall: P1-5. |
| Late-joiner race | **[S] fixed** | Reconcile after each upload (`transfer.js:297-305`). |
| SSE queues unbounded | **[S] fixed** | Byte-bounded queues; slow subscribers dropped (`server.ts:184-196`). |

## 5. Verified-good behavior on the current code

- **Long waits [V-cur transport; adapter waiting paths unchanged since v2].** A receiver and a sender each waited **150 s**, then completed with matching SHA-256 (`200` and `204`).
- **Waiting receiver disconnect [V-v2].** Released immediately (waiting count 1 → 0).
- **Framing [V-v2].** A `GET` with `Content-Length` and a pipelined next request returned two `200`s, with no desync and no smuggled request.
- **`Expect: 100-continue` [V-v2].** curl received `100 Continue` only when the upload was pulled, after the 307 redirect.
- **Receiver cancel stops reading [V-v2].** On v2, server reads stopped promptly after the 409. On the current adapter the response ends only after a full drain (P1-2).
- **Earlier transport checks.** In the initial review, Bun's `node:http` kept `Content-Length` for streamed writes while `Bun.serve` stripped it for every streaming body type.
- **Parent evidence [V-parent].**
  - 1 GiB to 3 receivers at 150.5 MiB/s input (451.5 MiB/s aggregate), 64.67 MiB sampled peak RSS.
  - Through Docker and nginx, 256 MiB to 2 receivers at 125.31 MiB/s with matching hashes.
  - Real-curl suite passing on Windows.
  - GNU Wget 1.25 on Linux passing after the drain fix.
  - Persistence across restart.
  - A non-root, read-only container.

## 6. Parity questions still open (for the Station study)

1. Does Station's CLI keep hosting after a receiver cancels mid-transfer? AirShare is being changed to keep hosting.
2. How does Station handle piped stdin? Does its infrastructure acknowledge `Expect` before the 307? Does it reject unknown-length entry bodies?
3. Station sends response headers to a waiting receiver at what point? AirShare intentionally waits for metadata, per the spec, so it can't send early. Behind a CDN with a read timeout (Cloudflare: 125 s) that matters.
4. The reference requires Base58 tags. AirShare accepts any tag of at most 256 characters without control characters, and its ids are 32 hex characters. The README states that byte-identical API behavior isn't promised.
5. Station returns `200` for no-redirect uploads. AirShare returns `200` on the Station routes and `204` on the native routes, consistent with that observation.

## 7. Performance assessment

- **Architecture.** One Bun process and one event loop carry every stream. Fan-out is lockstep, with a byte-bounded 64 KiB queue per receiver plus socket buffers. A stall eviction timer drops stuck receivers. Late joiners wait for the next complete upload. There is one replica.
  - Memory stays bounded and flat.
  - Throughput is limited by the slowest progressing receiver, and by CPU contention from any request flood (P1-4).
- **Loopback.** About 280 MiB/s for a single stream on Windows with Bun 1.4.0. That leaves ample headroom over Indian broadband and mobile rates (roughly 1–125 MiB/s), so the relay is not the bottleneck on a healthy host.
  - On a 1-vCPU VPS, measure with `bun run benchmark` before relying on it, especially under concurrent creation and status load.
- **Near India.**
  - The relay doubles the network path, so place the transfer host near both parties (Mumbai, Chennai, Hyderabad or Delhi regions).
  - Enable BBR with fq, and raise TCP buffer limits for high-latency paths.
  - Terminate TLS at Caddy or nginx with HTTP/2 for browsers.
  - Keep the transfer hostname off CDN proxies.
  - Fair comparison with Station: run both from the same client, with the same payload of at least 256 MiB, 3 receivers, and at least 5 repetitions. Report the median time to first byte and throughput. The parent's 4 MiB Station sample (2.15 MiB/s) is not comparable to loopback.

## 8. What still blocks "ready to deploy"

1. P1-1, P1-2 and P1-3 landed, with the listed regressions.
2. P1-4 mitigations (`synchronous=NORMAL`, admission) plus a re-measurement under creation load.
3. P1-5 entry policy and the two-step pipe flow, tested through compose and nginx with SHA-256 checks.
4. P1-6 per-client caps for receivers, SSEs and discards.
5. A TLS deployment example and a `PUBLIC_URL` safety net (P2-1, P2-3).
6. At least one **real-browser** end-to-end run on desktop Chrome and Android Chrome, covering:
   - sending to 2 receivers;
   - a receiver cancelling, then the next receiver being served;
   - reload then resume;
   - a Unicode filename;
   - a file over 128 MiB.
   Current frontend tests stop at the DOM, XHR and EventSource boundary.

## 9. Reproduction artifacts (private copies; ports hardcoded)

- **v2 snapshot scripts:**
  - `rv-cancel.mjs`: receiver cancel → 409 and server reads.
  - `rv-curlhost.mjs`: real curl hosting ends on cancel.
  - `rv-idle.mjs` with `rv-idle.log`: 150 s waits.
  - `rv-proto.mjs` and `rv-proto2.mjs`: waiting-receiver release; `GET`-with-body framing.
  - `rv-capacity.mjs`: lockout and creation-spam throughput.
  - `rv-capacity2.mjs`: restart lockout and status-spam control.
- **Initial-review scripts** (baseline `64e8756`) in `%TEMP%\airshare-opus-review-d62f1607`.
