# AirShare

AirShare is an MIT-licensed live file relay for browsers, curl and GNU Wget. Share a file from one device, open its link on another, and transfer it while the sender stays connected. AirShare has its own branding and implements Station307-style workflows and an API compatibility surface; it is an independent project.

The server streams bytes with backpressure. **File contents are never saved on the server.** SQLite stores SHA-256 hashes of the share links' keys (never the keys themselves), filenames, sizes, timestamps, transfer counters and a hash of the creator's client IP/prefix for quota accounting. Links survive a relay restart while their sender stays connected. A transfer that is running when the relay stops is cut: a browser sender sends again by itself once the relay is back and a receiver waits, a terminal sender reruns its command, and receivers download again.

## Start locally

Install [Bun](https://bun.sh/) **1.4.0 or newer** (the container uses 1.4.4):

```sh
bun install --frozen-lockfile
bun start
```

Open `http://localhost:3070`. Add files, share the receiver links or their QR codes, and keep the sender tab open. Downloads use the browser's native download manager without buffering the whole file in JavaScript. Multiple waiting receivers share one upload; receivers arriving after it starts get the next complete upload. The browser automatically serves that next group while it retains the file.

Closing or reloading the sending tab stops sharing, as on Station307. The page keeps its list of shared files only in memory and stores nothing in the browser, so a reopened or second tab starts with an empty list. The links of a closed tab stop working at once (or within `HOST_GRACE_MS` if the tab vanished without unloading), and anyone still waiting is told that the sender stopped sharing. Browsing Recipes, About and the other pages happens inside the same page, so it doesn't interrupt sharing.

Run checks with `bun test` and `bun run typecheck`. `bun run test:e2e` runs the browser tests with Playwright's Chromium (install it once with `bunx playwright install chromium`).

`bun run format` formats the code with Biome; `bun run format:check` only reports what would change, as CI does.

For Linux client coverage, including GNU Wget, run the isolated test image:

```sh
docker build --target test -t airshare-tests .
docker run --rm airshare-tests
```

The proxy integration check sends a long domain and a 1024-byte Unicode file name through nginx, including prepared stdin:

```sh
docker compose -p airshare-proxy-test -f compose.yaml -f compose.proxy.yaml -f compose.smoke.yaml up --build --abort-on-container-exit --exit-code-from smoke
docker compose -p airshare-proxy-test -f compose.yaml -f compose.proxy.yaml -f compose.smoke.yaml down --volumes
```

## Docker

```sh
docker compose up --build -d
```

The default binds only to `127.0.0.1:3070`. The container runs as an unprivileged user with a read-only filesystem and a writable metadata volume. `compose.yaml` also caps it at 256 processes and threads, 1 GiB of memory and 65536 open files; raise the memory cap if you raise `MAX_RECEIVERS` or `STREAM_HIGH_WATER_MARK`, since each receiver can queue `STREAM_HIGH_WATER_MARK` bytes. To use it on your LAN, explicitly set the bind address and the address other devices will use:

```sh
AIRSHARE_BIND=0.0.0.0 PUBLIC_URL=http://192.168.1.50:3070 docker compose up --build -d
```

In PowerShell, set environment variables first:

```powershell
$env:AIRSHARE_BIND = "0.0.0.0"
$env:PUBLIC_URL = "http://192.168.1.50:3070"
docker compose up --build -d
```

Use the host's actual LAN address. Plain HTTP is suitable only on networks you trust; use HTTPS for Internet transfers. Copy buttons include a fallback for HTTP LAN connections. `GET /healthz` is the container health check.

An optional nginx example is included:

```sh
docker compose -f compose.yaml -f compose.proxy.yaml up --build -d
```

Open `http://localhost:3080`. Set `PUBLIC_URL` to your public HTTPS origin when placing this behind TLS termination. See [deploy/nginx.conf](deploy/nginx.conf) for the streaming settings and adapt its listener/certificates to your host. Mount the persistent volume; running without it loses links on container replacement.

The proxy overlays require Docker Compose 2.24.4+ and keep the backend port private. They use a dedicated `172.28.240.0/24` network, assign the proxy `172.28.240.10`, and trust only that proxy address. If this overlaps another network, set both `AIRSHARE_NETWORK_CIDR` and a matching `AIRSHARE_PROXY_IP`; use different subnets for multiple instances. `TRUSTED_PROXIES` can explicitly override the proxy address. Never trust the bridge gateway or separately expose the backend to untrusted clients.

For a public domain with automatic HTTPS, use the Caddy example instead of nginx:

```sh
AIRSHARE_DOMAIN=share.example.com AIRSHARE_BIND=0.0.0.0 \
  docker compose -f compose.yaml -f compose.https.yaml up --build -d
```

Point your domain's DNS at the server and make ports 80/443 reachable first. This example sets `PUBLIC_URL` from the domain and preserves certificate state in a separate volume. Caddy terminates HTTPS, supports browser HTTP/2 and forwards the `103` responses described below. You supply the domain and server; the repository does not provision them.

`compose.yaml` passes every setting in [Configuration](#configuration) to the relay, except `HOST`, `PORT` and `DATA_DIR`, which the image fixes. These variables only shape the Compose deployment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AIRSHARE_BIND` | `127.0.0.1` | Host address the published ports listen on. |
| `AIRSHARE_PORT` | `3070` | Host port of the relay in `compose.yaml`. |
| `PROXY_PORT` | `3080` | Host port of nginx in `compose.proxy.yaml`. |
| `AIRSHARE_DOMAIN` | Required | Domain Caddy serves and certifies in `compose.https.yaml`. |
| `CADDY_HTTP_PORT`, `CADDY_HTTPS_PORT` | `80`, `443` | Host ports of Caddy. |
| `AIRSHARE_NETWORK_CIDR`, `AIRSHARE_PROXY_IP` | `172.28.240.0/24`, `172.28.240.10` | Proxy network and the one proxy address the relay trusts. |

### Backups

Links and their metadata live in `DATA_DIR`: `channels.sqlite` in the `airshare-data` volume under Compose. Stop the relay first so the database is complete, then copy the directory:

```sh
docker compose stop
docker compose cp airshare:/app/data ./airshare-data-backup
docker compose start
```

To restore, copy it back while the relay is stopped and give the files back to the `bun` user the relay runs as:

```sh
docker compose stop
docker compose cp ./airshare-data-backup/. airshare:/app/data
docker compose run --rm --no-deps --user root --cap-add CHOWN airshare chown -R bun:bun /app/data
docker compose start
```

## Terminal transfers

Replace the example origin with your instance. In Windows PowerShell, use `curl.exe` to avoid older PowerShell's `curl` alias, and `Select-String human` (or `findstr human`) in place of `grep human`. Station307's terminal recipes work with only the host changed.

### Send a file

```sh
curl -T myfile.zip -s -L -D - http://localhost:3070 | grep human
```

With no path after the host (or a path ending in `/`), curl appends the local file name, so this uploads `myfile.zip`. `| grep human` keeps only what you share:

```text
com.station307.human.info: Copy one of the two URLs, or scan the QR code
com.station307.human.transfer.url: http://localhost:3070/l/<receiverKey>/myfile.zip
com.station307.human.web.url: http://localhost:3070/r/<receiverKey>
x-airshare-human-info: Copy one of the two URLs, or scan the QR code
com.station307.human.qr-code: ▄▄▄ … (one line per row of a QR code for the web URL)
```

The transfer URL is a direct download (`curl -JLO <url>` or `wget --content-disposition <url>`). The web URL opens a download page. Neither lets anyone upload or delete. Keep the command running to keep hosting the file; press **Ctrl+C** to stop.

After each transfer a `307` redirect asks curl to send the file again for the next receiver, so keep `-L`. curl follows at most 50 redirects by default; add `--max-redirs -1` to host for more transfers than that. Only the first response carries the `human` headers, so the filtered output stays the same.

To choose the name, put it in the URL: `curl -T ./build/output.zip -L --max-redirs -1 -D - http://localhost:3070/xfr/release.zip`. The `/xfr/` paths from earlier releases still work, and `/xfr/` alone lets curl append the file name.

Scripts can read the same links from headers without `human` in their names: `x-airshare-download-url`, `x-airshare-receiver-page-url` and `x-airshare-qr-url` (an SVG of the QR code). `x-airshare-upload-url` is the sender link; keep it private.

### Receive first

```sh
curl -s -J -O -L -D - http://localhost:3070 | grep human
```

This prints the links to send to the person who has the file: a transfer URL (`/u/<senderKey>/`) and a web URL (`/send/<senderKey>`). They either open the web URL and pick a file, or run `curl -T <file> <transfer URL>`. Because the transfer URL ends in `/`, curl appends their file name and your `-J -O` saves it under that name. Your download starts when they send. `curl -f -L -J -O -D - http://localhost:3070/xfr` does the same. Scripts can read the sender page from `x-airshare-sender-page-url`.

Only `GET /` (from curl or Wget) and `GET /xfr…` start a receive, and a browser opening `/xfr` is sent to the home page instead. Other paths answer `404`, and `HEAD` never creates a channel, so uptime checks and typos don't use up channels. Uploading to a web page URL (`/r/…`, `/send/…`) answers `405` with an `Allow` header and the transfer URL to use instead.

### GNU Wget

```sh
wget --post-file=myfile.zip -S -O - http://localhost:3070/myfile.zip 2>&1 | grep human
wget --content-disposition -S http://localhost:3070 2>&1 | grep human
```

Wget doesn't send a file name, so put it in the URL. Without one (`wget --post-file=myfile.zip http://localhost:3070`), the file is named `airshare-<UTC yyyymmdd-hhmmss>.bin`. Wget follows at most 20 redirects; add `--max-redirect=1000000` to host for more transfers. Wget sends the whole body before reading the first redirect, so the first send may upload the file twice. For a one-off transfer, prepare a channel and send directly to its upload URL with `--header="x-airshare-no-redirect: 1"`.

### File names

- A name keeps only its last `/` or `\` segment. Names longer than 255 UTF-8 bytes are then shortened to 255 bytes on whole characters, keeping the extension.
- `-H "x-airshare-filename: <name>"` names an upload explicitly. Send it as raw UTF-8, or in the RFC 8187 form `UTF-8''<percent-encoded UTF-8>` (for example `UTF-8''caf%C3%A9.txt`), which doesn't depend on how a shell or client encodes header text. Control and bidirectional-override characters are replaced with `_`.
- Downloads carry both a UTF-8 `filename*` and an ASCII `filename`. For a non-ASCII name the ASCII form is percent-encoded, so `curl -J` saves `रिपोर्ट.pdf` as `%E0%A4%B0%E0%A4%BF%E0%A4%AA%E0%A5%8B%E0%A4%B0%E0%A5%8D%E0%A4%9F.pdf`; any URL decoder restores the name. Browsers use the UTF-8 name.
- A receive-first download that the sender never names is saved as `airshare-download`.

### Interim `103` responses

While a sender waits for a receiver, AirShare sends `HTTP/1.1 103 Early Hints` responses with `Link: </healthz>; rel=monitor`, first after about a second and then at doubling intervals up to 30 s. They carry no data. Writing them is how the relay notices that a waiting sender was stopped: otherwise the stop stays hidden behind the unread upload, the share looks online, and the next receiver gets an incomplete file. They appear with a bare `-D -` or `wget -S`; `| grep human` hides them. `LIVENESS_HINTS=off` turns them off.

### Pipes, folders and one-off streams

Pipes cannot be replayed, so prepare a channel first and then stream directly to its upload URL. This avoids redirects consuming stdin, including behind a reverse proxy:

```sh
UPLOAD_URL=$(curl -fsS -X POST -D /dev/stderr "http://localhost:3070/xfr/folder.tar.gz?prepare=1")
tar -czf - ./folder | curl -f -T - "$UPLOAD_URL"
```

The first command prints the receiver links and QR code in response headers (on stderr), and its body is only the upload URL. The second command sends the pipe once and exits. Station307's one-line pipe recipe (`tar … | curl -s -L -T - -D - <host>/folder.tar.gz | grep human`) gets `411` instead, with an `x-airshare-human-info` header that shows these two commands: proxies can send `100 Continue` before an upstream redirect and silently consume part of a non-rewindable input, so AirShare refuses an unprepared unknown-length upload rather than accept a potentially partial file.

Use the same preparation for generated logs, encrypted output or process dumps. These examples use POSIX shell syntax. Keep transfer output separate from the input pipe; use synthetic data for test transfers.

For native binary pipes on Windows, use PowerShell **7.4+** or `cmd.exe`; Windows PowerShell 5.1 can alter binary data. Unknown-length streams cannot prove that their producer generated all intended bytes. Use self-checking archives/checksums, or provide `x-airshare-file-size` when the expected byte count is known.

To download a browser share in a terminal, use the direct URL from **copy URL**, or the `downloadUrl` from the API. Web page URLs return a page.

## HTTP API

Create a channel:

```sh
curl -sS -H "Content-Type: application/json" \
  --data '{"filename":"hello.txt","contentType":"text/plain","contentLength":5}' \
  http://localhost:3070/api/channels
```

JSON requests (`/api/channels`, `/api/v1/channel`, `/api/presence`) must send `Content-Type: application/json`; anything else gets `415`. Browsers on other websites can't create, change or delete shares. A write whose `Origin` header names another site gets `403` with reason `cross_origin`; a page opened through another address of the same relay, such as `localhost`, a LAN address or a proxy port, counts as the same site when the request's `Host` header, or a trusted proxy's `X-Forwarded-Host`, names that address. Any request that would create a share also gets `403` with reason `cross_origin` when its `Sec-Fetch-Site` header is `cross-site` or `same-site`. A plain `GET` from a link, image or frame sends no `Origin`, and browsers send `Sec-Fetch-Site` only to HTTPS and loopback addresses, so a receive started by a `GET` (`/xfr`, `/xfr/<name>`) refuses every browser, meaning a `User-Agent` that starts with `Mozilla/` and isn't PowerShell's: an address opened in the browser is redirected to the home page (`303`), and an image, frame, script or `fetch()` gets `403` with reason `browser_entry`. curl, Wget, PowerShell and other terminal clients send neither header and aren't affected. Only downloads, status reads and `/healthz` answer cross-origin reads (`Access-Control-Allow-Origin: *`).

The response contains `uploadUrl`, `downloadUrl`, `humanUrl`, `eventsUrl`, `statusUrl` and `deleteUrl`. Start the download and upload concurrently; there is no stored file to fetch later:

```sh
curl -f "<downloadUrl>" -o hello.txt
# In another terminal:
curl -f -H "x-airshare-no-redirect: 1" -T ./hello.txt "<uploadUrl>"
```

Transfer links are short: `uploadUrl` is `/u/<senderKey>/<name>` and `downloadUrl` is `/l/<receiverKey>/<name>`. A trailing `/u/<senderKey>/` lets curl append the local filename. The older `/download/…`, `/api/channels/<key>/upload/…` and Station transfer routes, and 32-character hex keys from earlier releases, keep working.

With `x-airshare-no-redirect: 1` (or Station's `com.station307.no-redirect: true`) a finished upload answers `200` with `{"succeeded":{"bytes_sent":N,"bytes_received":N,"receiver_count":R}}`. Station-style no-redirect uploads, and native uploads that send `x-airshare-hash: 1`, also get `"hash"`: the SHA-256 of the bytes relayed, so receivers can verify their copy. Uploads tied to a Station-format tracker (`com.station307.tracker`) are hashed too, and report the hash in that tracker's `transfer_event`, as Station307 does. Hashing costs relay throughput, so other uploads skip it; `TRANSFER_HASH=off` disables it everywhere. A failed upload answers with `{"error","reason","retryable","failed":{…}}`; deleting the share before every receiver has the last bytes counts as a failure (`410`, reason `deleted`). `succeeded` counts a receiver once every byte has been handed to its connection. Like any HTTP server, the relay can't tell whether a receiver that disconnects right after that read what was still in its socket buffers (a few hundred KiB). Uploading to a sender link while another upload is still waiting for receivers replaces it (the older request gets `409` with reason `replaced`); a link that is already streaming answers `409` with reason `busy`.

Add `"hostBound": true` when the channel belongs to a browser tab. Such a channel closes `HOST_GRACE_MS` after its last hosting signal (a `?hosting=1` event stream, a sender presence lease, a sender or channel tracker, or an upload). When a hosting stream or hosting tracker subscription ends, the channel's presence lease ends with it, so a crashed tab's share closes one grace period later instead of after the rest of its lease. Terminal and plain API channels aren't host-bound. A closing tab can end its share at once with `DELETE <deleteUrl>?reason=sender_left`; a plain `DELETE` closes it as `deleted`.

For an hour after a channel closes, its owner, sender and receiver URLs answer `410` with `{"error": "…", "reason": "sender_left" | "deleted" | "expired"}` instead of `404`. Event streams receive a final `closed` event with the same body.

One page can follow many channels on a single event stream. Open `GET /api/v1/track?format=native`, read the `tracker_key` from the first `tracker_event`, then `POST /api/channels/<key>/subscribe/<tracker_key>` for each owner, sender or receiver key (add `?hosting=1` while the page holds the file) and `DELETE` the same URL to stop. The stream sends each key's status as a `status` event and a final `closed` event with `id`, `error` and `reason`. Without `format=native` the tracker keeps the Station event format.

If a page can't keep a stream open, it can renew many presence leases at once: `POST /api/presence` with `{"keys":["<ownerOrSenderKey>",…],"hosting":true}` (at most `MAX_PRESENCE_KEYS` keys) returns `{"channels":{<key>:<status>},"closed":{<key>:{"error","reason"}},"unknown":[<key>]}`. Send it more often than `SENDER_LEASE_MS`; `"hosting":false` releases the leases. A larger batch answers `400` with `{"error","reason":"too_many_keys","max":N}`; split it into requests of at most `max` keys.

Owner, sender and receiver links use different random capabilities. Receivers cannot obtain upload or delete capabilities. Keep owner and sender URLs private; anyone holding a capability can use its permitted operations. `DELETE <deleteUrl>` revokes the channel and cancels its active transfers. Browser status connections are bounded, with polling fallback to avoid exhausting HTTP/1 connections.

Station-style compatibility routes include `POST /api/v1/channel`, `GET /api/v1/track`, channel/sender/receiver tracker subscriptions, `POST`/`PUT` uploads and `GET` downloads. The `com.station307.no-redirect`, tracker and tag headers are accepted. AirShare's own frontend and CLI flows are the supported clients; undocumented Station307 backend details and byte-identical API behavior are not promised.

## Self-hosting for speed and reliability

Place the relay on a host with good connectivity to **both** sender and receiver. A nearby host can shorten the route, but local benchmarks cannot predict your Internet transfer speed. The sender's upload, the server's outbound bandwidth and the receiver's download all matter. Multiple receivers share the sender upload but each consumes server egress.

- Use a long-running host. Functions with request deadlines are unsuitable for waiting receivers and large transfers.
- Set `PUBLIC_URL=https://share.example.com` when using a reverse proxy. It must be an origin with no path, query or credentials. AirShare intentionally does not trust arbitrary forwarded headers.
- Disable request and response buffering; remove proxy upload body limits; use sufficiently long read/send timeouts. The nginx example does this. A CDN/proxy may impose its own size or duration limits even when AirShare does not.
- For a custom nginx setup, increase the response-header buffer for QR rows and encoded Unicode URLs: the example uses `proxy_buffer_size 64k`, `proxy_buffers 4 64k`, and `proxy_busy_buffers_size 128k`. File-body buffering remains disabled.
- The examples use 24-hour proxy idle timeouts; they do not promise an unlimited idle connection. nginx also includes per-IP request and connection limits to protect active transfers from API floods. Adjust those budgets for your users and upstream proxy topology.
- Use HTTPS for Internet-facing traffic. The relay sees plaintext bytes inside the server process; this is **not end-to-end encryption**. Encrypt files before sending if the relay must not read them.
- Use one AirShare process/replica per instance. Active streams and subscriptions live in that process; SQLite persistence is not distributed routing.
- A multicast upload is paced by its slowest progressing receiver. Completely stalled receivers are disconnected after the configured stall timeout so healthy peers can finish.
- An anonymous public relay consumes bandwidth and has no built-in accounts. Put access controls and per-client rate limits at your proxy if needed. Do not expose the metadata volume: it holds filenames, and although share keys are stored only as hashes, it shows what is being shared.

The app and metadata writer share one event loop, so sufficiently heavy unrelated requests can reduce throughput. Application admission limits and nginx's request limits reduce this risk; an anonymous relay is not a DDoS-protection service.

On `SIGTERM` or `SIGINT` the relay saves channel metadata, answers waiting receivers and uploads with `503` (reason `stopping`, `Retry-After: 5`), ends status streams and exits within about 2 s, even if a client still holds a connection.

No application-level file-size limit is imposed by default below JavaScript's safe integer range; runtime, proxy, disk on the receiving device and network limits still apply. Failed or interrupted transfers must be restarted; there is no byte-range resume because the relay retains no file contents.

### Upgrading from releases before host-bound shares

Browser shares created by an older frontend load as ordinary (not host-bound) channels, and their owner links were kept only in the browser storage that the new frontend clears. Nobody can resume or delete them, so their receivers wait until the channel expires (`UNUSED_CHANNEL_TTL_MS`, or `CHANNEL_TTL_MS` once a share was used). To end them at once, stop the server and remove `channels.sqlite` from `DATA_DIR`; that also ends every terminal and API link.

### Upgrading from releases that stored raw share keys

The first start converts every stored share to hashed keys: the owner, sender and receiver keys are replaced by their SHA-256 hashes, and the sender and receiver keys are kept only encrypted under the key one level above them, so each link still shows its own URLs after a restart. The old table is dropped and the database file is rewritten, so no raw key stays on disk. A rewrite that a crash or a full disk cuts short runs again at the next start; a finished one sets `PRAGMA user_version` to `2`, and a database without that mark, including one converted by an earlier release, is rewritten once. Existing links keep working. The conversion is one-way: an older release can't read the new table, so back up `DATA_DIR` (see [Backups](#backups)) before upgrading if you might roll back.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` for local-only Bun use. |
| `PORT` | `3070` | Listener port. |
| `PUBLIC_URL` | Request origin | Public origin used in links, especially behind HTTPS proxies. |
| `DATA_DIR` | `./data` | Metadata directory; `:memory:` disables persistence. |
| `CHANNEL_TTL_MS` | `86400000` | Inactive channel lifetime, 24 hours, measured from the last hosting, receiver or transfer activity. Status reads and plain subscriptions don't extend it. Active uploads are preserved. |
| `CLEANUP_INTERVAL_MS` | `60000` | Expired-channel cleanup interval. |
| `MAX_CHANNELS` | `10000` | Channel capacity. |
| `MAX_CHANNELS_PER_CLIENT` | `256` | Live channels per client, persisted across restart; `0` disables this quota. |
| `UNUSED_CHANNEL_TTL_MS` | `3600000` | Continuous unprotected time before a never-used terminal or API channel expires, 1 hour; hosting or a waiting peer resets it. Browser shares end through `HOST_GRACE_MS` instead. |
| `HOST_GRACE_MS` | `20000` | How long a browser share (`hostBound`) survives without its tab, which covers reconnects and server restarts. After that it closes as `sender_left` and waiting receivers get `410`. |
| `SENDER_LEASE_MS` | `10000` | How long one presence renewal counts as the sender being online: a `POST /api/presence` with `"hosting":true`, or a status read with `x-airshare-sender-presence: 1`. |
| `CHANNEL_CREATION_BURST` | `30` | Per-client channel creation burst; `0` disables this limiter. |
| `CHANNEL_CREATION_INTERVAL_MS` | `60000` | Token-bucket refill interval. |
| `MAX_CREATION_BUCKETS` | `4096` | Bounded client creation-rate accounting. |
| `TRUSTED_PROXIES` | Empty | Opt-in trusted proxy IPs/CIDRs for client-IP forwarding. |
| `MAX_RECEIVERS_PER_CHANNEL` | `64` | Waiting plus active receivers per channel. |
| `MAX_RECEIVERS` | `4096` | Total waiting plus active receivers. |
| `MAX_RECEIVERS_PER_CLIENT` | `128` | Per-client share of receiver capacity. |
| `MAX_UPLOADS_PER_CLIENT` | `32` | Uploads one client can have open at once, including uploads still waiting for a receiver. Extra uploads get `429` with reason `upload_limit` and `Retry-After: 1`. |
| `MAX_SUBSCRIBERS_PER_CHANNEL` | `64` | Channel status subscriptions. |
| `MAX_SUBSCRIBERS` | `4096` | Total status/tracker connections. |
| `MAX_SUBSCRIBERS_PER_CLIENT` | `64` | Per-client share of status/tracker connections. |
| `MAX_DISCARDS` | `64` | Concurrent ignored request bodies being streamed away. |
| `MAX_DISCARDS_PER_CLIENT` | `8` | Per-client share of discarded-body connections. |
| `MAX_TRACKER_CHANNELS` | `256` | Subscriptions per Station-style tracker. |
| `MAX_PRESENCE_KEYS` | `256` | Keys per `POST /api/presence` request. Keep it within what fits in `MAX_METADATA_BYTES` (about 35 bytes per key). |
| `MAX_REQUEST_BODY_SIZE` | `9007199254740991` | Streaming request body ceiling in bytes. |
| `MAX_METADATA_BYTES` | `16384` | JSON metadata ceiling, including chunked requests. |
| `CONTROL_BODY_TIMEOUT_MS` | `10000` | Time allowed for a JSON request body to arrive in full; a slower one gets `408` with reason `body_timeout` and its connection is closed. File uploads have no such limit. |
| `LIVENESS_HINTS` | `on` | `off` stops the `103` responses that detect a stopped terminal sender while it waits (see [Interim 103 responses](#interim-103-responses)). |
| `TRANSFER_HASH` | `on` | `off` never computes upload SHA-256 hashes, even when a client asks. |
| `STREAM_HIGH_WATER_MARK` | `65536` | Per-stream queue budget in bytes. |
| `RECEIVER_STALL_TIMEOUT_MS` | `120000` | Drop an active receiver blocked without queue progress. |
| `RECEIVER_FIRST_BYTE_TIMEOUT_MS` | `15000` | The same limit, shorter, until a receiver has taken 16 × `STREAM_HIGH_WATER_MARK` bytes (1 MiB by default). A receiver whose network vanished while it waited is dropped this quickly instead of holding the others back. |

At startup the relay warns when `SENDER_LEASE_MS` is under 4 s or `HOST_GRACE_MS + SENDER_LEASE_MS` is under 30 s: a slow status poll or a brief network drop could then end browser shares.

Host memory usage also depends on connection counts and runtime/socket buffers. The queue budget is not the entire process memory limit.

Channel creation and concurrent receiver/event/discard connections use the actual peer IP by default. The supplied overlays trust only their proxy's static address. For another reverse proxy, set `TRUSTED_PROXIES` to its exact IP (comma-separated literal IPs/CIDRs are supported); otherwise clients share that peer's budgets. nginx appends `X-Forwarded-For`; AirShare only consults it for an explicitly trusted peer. Avoid trusting bridge gateways, broad private networks or arbitrary Internet addresses.

Docker Desktop, rootless Docker, IPv6-to-IPv4 userland proxying and carrier NAT may replace multiple client addresses with one gateway/NAT address. Those clients share the same budgets; do not broaden proxy trust to compensate, because that would allow spoofing. Use a deployment that preserves source addresses, or configure suitable upstream access/limits and adjust these budgets for the expected shared audience. Operators with equivalent creation limits upstream can set `CHANNEL_CREATION_BURST=0`; concurrency budgets remain separately configurable.

The liveness mechanism uses non-fetching HTTP 103 hints. Use the supplied nginx **1.29+** config with `early_hints 1`, or Caddy; older distribution nginx versions do not support this forwarding behavior. Behind a proxy that cannot forward `103`, set `LIVENESS_HINTS=off`.

## Measure your host

```sh
bun run benchmark --mib=256 --receivers=1
bun run benchmark --mib=1024 --receivers=3
bun run benchmark --mib=256 --url=https://share.example.com --output=benchmark-results.json
```

Without `--url`, this launches an isolated loopback instance with in-memory metadata. It generates bytes incrementally, hashes every received stream, and samples the server's RSS independently of the test client. With `--url`, it exercises that existing instance and deletes only its own test channel. Tests use synthetic data, so no personal file is uploaded. Loopback results measure relay overhead and **do not establish a speed advantage over Station307 on the Internet**.

[docs/PARITY.md](docs/PARITY.md) compares AirShare with Station307 feature by feature and lists what was not verified. Earlier audit notes in [docs/](docs/) are kept as historical records.

## License

MIT. AirShare is not affiliated with Station307.
