# AirShare functional parity and reliability

## Intent

Make the existing AirShare project a reliable open-source alternative to Station307, with AirShare branding and the same practical browser, curl, wget, live-stream and multiple-receiver workflows. The user intends to self-host near India because remote transfer performance is poor. They explicitly authorize investigation, synthetic test transfers, fixes and improvements.

## Constraints and decisions

- Match Station307's visual layout, typography, colors and controls one-to-one, retaining the AirShare name and valid local URLs. The user's supplied screenshot and the live site are the visual reference.
- Keep Bun, TypeScript, plain browser JavaScript and streaming HTTP. Do not copy Station307's proprietary bundle or branding into the product.
- File bytes must never be written to server storage or buffered in full. Persist channel metadata/tokens only; restarting cannot preserve in-flight bytes or resurrect a File after its browser closes.
- Preserve sender-first and receiver-first workflows, repeated transfers while a sender hosts a file, concurrent waiting receivers, streamed stdin, zero-byte files, Unicode filenames and very large files.
- Receiver capabilities must not permit uploading, deletion or discovering owner/sender capabilities. Enforce roles on every native and Station-compatible route, not merely in UI.
- Use explicit PUBLIC_URL for a reverse proxy's externally visible origin. Do not trust arbitrary forwarded headers. Self-hosting guidance must disable proxy buffering, body limits and short transfer timeouts.
- Keep receiver responses pending until sender metadata is known. Backpressure must bound memory. A live multicast can be paced by its slowest receiver; this is a real constraint, not a promise of unlimited bandwidth.
- Persistent metadata has a configurable lifetime and bounded channel/subscriber/receiver counts. Active transfers are not expired mid-transfer. Malformed input returns a controlled 4xx.
- QR codes are generated locally, with no external service. Browser clipboard and navigation must work on HTTP LAN hosts as well as HTTPS.
- Tests must exercise real HTTP streams and client state transitions. Browser and curl transfers must be checked by content/hash, not just HTTP status.
- Do not claim perfection, universal browser support, exact undocumented backend equivalence, or India-to-host throughput without evidence. Report remaining verification limits plainly.

## Reference observed on November 3, 2026

Station307 homepage, recipes and public DefaultTransfers.CdcjUhSp.js bundle were inspected. The browser uses POST /api/v1/channel, GET /api/v1/track, POST /api/v1/channel/{channel|sender/key|receiver/key}/subscribe/{tracker}, and transfer-event SSE. Uploads use com.station307.no-redirect=true for browser requests. CLI entry responds 307 and exposes role-specific human/transfer URLs and terminal QR headers. The homepage advertises repeated hosting until Ctrl+C/tab close, multiple receivers, no file storage/size limit, asymmetric capabilities and persistent tokens.

Downloaded reference assets and synthetic test payloads live in the system temporary airshare-audit-20261103 directory and are not product assets.

## Native interface

POST /api/channels returns an owner payload with id, file, uploadUrl, downloadUrl, humanUrl, eventsUrl, statusUrl and deleteUrl. Transfer URLs use separate sender/receiver tokens. Role-specific GET/status/event payloads expose only permitted URLs; id identifies that perspective's capability, never an owner token to a receiver. Status includes file, waitingReceivers, activeUpload, completedTransfers and senderOnline. Deletion emits a closed event and cancels in-flight transfers. Browser receiver status must not misrepresent another receiver's completion as its own.

## Verification

Cover role confusion/leaks, malformed metadata, static traversal, zero/unknown/mismatched lengths, >128 MiB transfer, receiver-first correct filename, interrupted streams, aborting/deleting while active, backpressure, late receivers, repeated CLI transfers, restarts/expiration, proxy URLs, health checks and offline runtime assets. Independent Opus 5.5 Max review is required both for initial findings and the final fixes.
