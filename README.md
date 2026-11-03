# AirShare

AirShare is an MIT-licensed live file relay for browsers, curl and GNU Wget. Share a file from one device, open its link on another, and transfer it while the sender stays connected. AirShare has its own branding and implements Station307-style workflows and an API compatibility surface; it is an independent project.

The server streams bytes with backpressure. **File contents are never saved on the server.** SQLite stores channel tokens, filenames, sizes, timestamps, transfer counters and a hash of the creator's client IP/prefix for quota accounting. Links can survive a restart; in-flight transfers cannot, so the sender must reconnect and resend.

## Start locally

Install [Bun](https://bun.sh/) **1.4.0 or newer** (the container uses 1.4.4):

```sh
bun install --frozen-lockfile
bun start
```

Open `http://localhost:3070`. Add files, share the receiver links or their QR codes, and keep the sender tab open. Downloads use the browser's native download manager without buffering the whole file in JavaScript. Multiple waiting receivers share one upload; receivers arriving after it starts get the next complete upload. The browser automatically serves that next group while it retains the file.

After reloading a sender page, reselect the file to host it again. The browser remembers channel metadata, not permission to read files from disk. Closing the tab ends hosting; a retained receiver link can be used again when the sender returns before the channel expires.

Run checks with `bun test` and `bun run typecheck`.

For Linux client coverage, including GNU Wget, run the isolated test image:

```sh
docker build --target test -t airshare-tests .
docker run --rm airshare-tests
```

The proxy integration check also exercises a long domain and the maximum Unicode filename through nginx, including prepared stdin:

```sh
docker compose -p airshare-proxy-test -f compose.yaml -f compose.proxy.yaml -f compose.smoke.yaml up --build --abort-on-container-exit --exit-code-from smoke
docker compose -p airshare-proxy-test -f compose.yaml -f compose.proxy.yaml -f compose.smoke.yaml down --volumes
```

## Docker

```sh
docker compose up --build -d
```

The default binds only to `127.0.0.1:3070`. The container runs as an unprivileged user with a read-only filesystem and a writable metadata volume. To use it on your LAN, explicitly set the bind address and the address other devices will use:

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

Point your domain's DNS at the server and make ports 80/443 reachable first. This example sets `PUBLIC_URL` from the domain and preserves certificate state in a separate volume. Caddy terminates HTTPS and supports browser HTTP/2. You supply the domain and server; the repository does not provision them.

## Terminal transfers

Replace the example origin with your instance. In Windows PowerShell, use `curl.exe` to avoid older PowerShell's `curl` alias.

Send a regular file and keep hosting it for later receivers:

```sh
curl -T "./myfile.zip" -L --max-redirs -1 -D - "http://localhost:3070/xfr/myfile.zip"
```

Or let curl append the filename by ending the entry URL in `/`:

```sh
curl -T "./myfile.zip" -L --max-redirs -1 -D - "http://localhost:3070/xfr/"
```

Read `x-airshare-human-url` from the headers, or scan the terminal QR. Keep the command running; press **Ctrl+C** to stop. After each transfer a 307 redirect asks curl to replay the regular file. `--max-redirs -1` avoids curl's default redirect count limiting repeated hosting. QR rows use numbered headers because Fetch's Headers API combines repeated names.

To receive first, run this and share its `x-airshare-human-url` with the sender:

```sh
curl -f -L -J -O -D - "http://localhost:3070/xfr"
```

The sender opens that link and selects a file, or uploads to the printed `x-airshare-upload-url`. The download waits until the sender provides the filename, type and size. curl's ASCII fallback filename may differ for non-ASCII names; browsers can use the UTF-8 `filename*` header.

GNU Wget:

```sh
wget --post-file="./myfile.zip" --max-redirect=1000000 --server-response --output-document=- "http://localhost:3070/xfr/myfile.zip"
wget --content-disposition --server-response "http://localhost:3070/xfr"
```

Wget sends an eager POST body before reading the initial redirect, so the first send may upload the file twice. To avoid that startup cost for a one-off transfer, prepare a channel first and send directly to its upload URL with `--header="x-airshare-no-redirect: 1"`.

To download a browser share in a terminal, use the direct URL from **Copy download URL**, or the `downloadUrl` from the API. Human receiver URLs return a web page.

### Pipes, folders and one-off streams

Pipes cannot be replayed. Prepare a channel first, then stream directly to its sender URL. This avoids redirects consuming stdin, including behind a reverse proxy:

```sh
upload_url=$(curl -fsS -X POST -D /dev/stderr "http://localhost:3070/xfr/folder.tar.gz?prepare=1")
tar -czf - ./folder | curl -f -T - "$upload_url"
```

The first command prints the receiver link and QR in response headers; its body contains only the upload URL. The second command sends the pipe once and exits. Do not use `-L` to send stdin to the creation entry: proxies can send `100 Continue` before an upstream redirect and silently consume part of a non-rewindable input. AirShare rejects an unprepared unknown-length creation upload with instructions instead of accepting a potentially partial file.

Use the same preparation for generated logs, encrypted output or process dumps. These examples use POSIX shell syntax. Keep transfer output separate from the input pipe; use synthetic data for test transfers.

For native binary pipes on Windows, use PowerShell **7.4+** or `cmd.exe`; Windows PowerShell 5.1 can alter binary data. Unknown-length streams cannot prove that their producer generated all intended bytes. Use self-checking archives/checksums, or provide `x-airshare-file-size` when the expected byte count is known.

## HTTP API

Create a channel:

```sh
curl -sS -H "Content-Type: application/json" \
  --data '{"filename":"hello.txt","contentType":"text/plain","contentLength":5}' \
  http://localhost:3070/api/channels
```

The response contains `uploadUrl`, `downloadUrl`, `humanUrl`, `eventsUrl`, `statusUrl` and `deleteUrl`. Start the download and upload concurrently; there is no stored file to fetch later:

```sh
curl -f "<downloadUrl>" -o hello.txt
# In another terminal:
curl -f -H "x-airshare-no-redirect: 1" -T ./hello.txt "<uploadUrl>"
```

Owner, sender and receiver links use different random capabilities. Receivers cannot obtain upload or delete capabilities. Keep owner and sender URLs private; anyone holding a capability can use its permitted operations. `DELETE <deleteUrl>` revokes the channel and cancels its active transfers. Native SSE sends `status` and terminal `closed` events. Browser status connections are bounded, with polling fallback to avoid exhausting HTTP/1 connections.

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
- An anonymous public relay consumes bandwidth and has no built-in accounts. Put access controls and per-client rate limits at your proxy if needed. Do not expose the metadata volume: it contains capability secrets and filenames.

The app and metadata writer share one event loop, so sufficiently heavy unrelated requests can reduce throughput. Application admission limits and nginx's request limits reduce this risk; an anonymous relay is not a DDoS-protection service.

No application-level file-size limit is imposed by default below JavaScript's safe integer range; runtime, proxy, disk on the receiving device and network limits still apply. Failed or interrupted transfers must be restarted; there is no byte-range resume because the relay retains no file contents.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` for local-only Bun use. |
| `PORT` | `3070` | Listener port. |
| `PUBLIC_URL` | Request origin | Public origin used in links, especially behind HTTPS proxies. |
| `DATA_DIR` | `./data` | Metadata directory; `:memory:` disables persistence. |
| `CHANNEL_TTL_MS` | `86400000` | Inactive channel lifetime, 24 hours. Active uploads are preserved. |
| `CLEANUP_INTERVAL_MS` | `60000` | Expired-channel cleanup interval. |
| `MAX_CHANNELS` | `10000` | Channel capacity. |
| `MAX_CHANNELS_PER_CLIENT` | `256` | Live channels per client, persisted across restart; `0` disables this quota. |
| `UNUSED_CHANNEL_TTL_MS` | `300000` | Continuous unprotected time before an unused channel expires; hosting or a waiting peer resets its grace. |
| `CHANNEL_CREATION_BURST` | `30` | Per-client channel creation burst; `0` disables this limiter. |
| `CHANNEL_CREATION_INTERVAL_MS` | `60000` | Token-bucket refill interval. |
| `MAX_CREATION_BUCKETS` | `4096` | Bounded client creation-rate accounting. |
| `TRUSTED_PROXIES` | Empty | Opt-in trusted proxy IPs/CIDRs for client-IP forwarding. |
| `MAX_RECEIVERS_PER_CHANNEL` | `64` | Waiting plus active receivers per channel. |
| `MAX_RECEIVERS` | `4096` | Total waiting plus active receivers. |
| `MAX_RECEIVERS_PER_CLIENT` | `128` | Per-client share of receiver capacity. |
| `MAX_SUBSCRIBERS_PER_CHANNEL` | `64` | Channel status subscriptions. |
| `MAX_SUBSCRIBERS` | `4096` | Total status/tracker connections. |
| `MAX_SUBSCRIBERS_PER_CLIENT` | `64` | Per-client share of status/tracker connections. |
| `MAX_DISCARDS` | `64` | Concurrent ignored request bodies being streamed away. |
| `MAX_DISCARDS_PER_CLIENT` | `8` | Per-client share of discarded-body connections. |
| `MAX_TRACKER_CHANNELS` | `256` | Subscriptions per Station-style tracker. |
| `MAX_REQUEST_BODY_SIZE` | `9007199254740991` | Streaming request body ceiling in bytes. |
| `MAX_METADATA_BYTES` | `16384` | JSON metadata ceiling, including chunked requests. |
| `STREAM_HIGH_WATER_MARK` | `65536` | Per-stream queue budget in bytes. |
| `RECEIVER_STALL_TIMEOUT_MS` | `120000` | Drop an active receiver blocked without queue progress. |

Host memory usage also depends on connection counts and runtime/socket buffers. The queue budget is not the entire process memory limit.

Channel creation and concurrent receiver/event/discard connections use the actual peer IP by default. The supplied overlays trust only their proxy's static address. For another reverse proxy, set `TRUSTED_PROXIES` to its exact IP (comma-separated literal IPs/CIDRs are supported); otherwise clients share that peer's budgets. nginx appends `X-Forwarded-For`; AirShare only consults it for an explicitly trusted peer. Avoid trusting bridge gateways, broad private networks or arbitrary Internet addresses.

Docker Desktop, rootless Docker, IPv6-to-IPv4 userland proxying and carrier NAT may replace multiple client addresses with one gateway/NAT address. Those clients share the same budgets; do not broaden proxy trust to compensate, because that would allow spoofing. Use a deployment that preserves source addresses, or configure suitable upstream access/limits and adjust these budgets for the expected shared audience. Operators with equivalent creation limits upstream can set `CHANNEL_CREATION_BURST=0`; concurrency budgets remain separately configurable.

The liveness mechanism uses non-fetching HTTP 103 hints. Use the supplied nginx **1.29+** config with `early_hints 1`, or Caddy; older distribution nginx versions do not support this forwarding behavior.

## Measure your host

```sh
bun run benchmark --mib=256 --receivers=1
bun run benchmark --mib=1024 --receivers=3
bun run benchmark --mib=256 --url=https://share.example.com --output=benchmark-results.json
```

Without `--url`, this launches an isolated loopback instance with in-memory metadata. It generates bytes incrementally, hashes every received stream, and samples the server's RSS independently of the test client. With `--url`, it exercises that existing instance and deletes only its own test channel. Tests use synthetic data, so no personal file is uploaded. Loopback results measure relay overhead and **do not establish a speed advantage over Station307 on the Internet**.

See [docs/AUDIT-2026-11-03.md](docs/AUDIT-2026-11-03.md) for the audit, parity checklist and verification boundaries.

## License

MIT. AirShare is not affiliated with Station307.
