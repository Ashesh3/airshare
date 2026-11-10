# Station307 Parity Implementation Plan

> **For agentic workers:** Use the subagent-driven-development or executing-plans workflow. User has already authorized review, fixes, and improvements; proceed within this scope.

**Goal:** Deliver a tested, self-hostable AirShare with Station307's practical transfer workflows and repaired reliability/security defects.

**Architecture:** Retain streaming HTTP relay and plain browser UI. Persist only bounded channel metadata. Separate owner, sender, and receiver capabilities, and test the public HTTP contract with real streams.

**Tech stack:** Bun, TypeScript, native browser File/XHR/EventSource, SQLite metadata, local QR encoding.

**Spec:** ../specs/2026-11-03-station307-parity-design.md

## Global constraints

- Preserve AirShare branding; reference bundles remain outside the repository.
- No server-side file storage or full-file buffering.
- Retain browser, curl, wget and piped stdin workflows.
- Receiver tokens cannot reveal or act as sender/owner tokens.
- User explicitly authorizes fixes; changes remain in the current checkout on codex/station307-parity-audit.
- Report measured evidence and verification limitations honestly.

## Review focus

- Receiver joins during an upload: receives a complete subsequent stream, never a partial file or an infinite UI stall.
- Download begins before metadata exists: correct filename/type/length when upload arrives.
- Slow/disconnected peer: bounded memory, cancelable producer, accurate result.
- Malicious filenames/paths/JSON: controlled responses and no capability or filesystem escape.
- Reverse proxy/restart: public URLs remain usable, metadata survives, active bytes do not pretend to resume.

## Task 1: Streaming server and capability boundaries

**Own:** src/server.ts, supporting src modules, tests/server.test.ts and server test utilities.
**Interfaces:** Native role-specific payloads as defined in the spec. Preserve Station tracker API event shapes and headers. Provide healthz; QR endpoint contract supplied by coordinator.

- [x] Reproduce failures against initial commit with meaningful real HTTP tests.
- [x] Enforce role checks and redacted payloads; validate inputs and static asset paths.
- [x] Repair stream lifecycle, metadata timing, zero/unknown/large lengths, aborts, deletion and backpressure; repeat CLI hosting with 307 and no-redirect browser success.
- [x] Add persisted metadata, expiry and resource limits; PUBLIC_URL and no-buffering headers.
- [x] Run server suite and type checks, documenting exact outcomes.
- [x] Resolve independent review findings.

## Task 2: Browser hosting and receive flows

**Own:** public/*.js, public/index.html, public/styles.css, tests/frontend.test.ts.
**Consumes:** role payloads, native status/event URLs, optional closed event; never relies on owner tokens in receiver pages.

- [x] Test late-receiver race, failure persistence and stopping while upload resolves.
- [x] Implement a shared host state machine with bounded retries, explicit failures, disconnect/reconnect handling and replay for waiting receivers.
- [x] Preserve native File uploads and browser attachment downloads. Add clear progress semantics and receiver status that does not falsely claim success.
- [x] Add HTTP clipboard fallback, dynamic origin recipes, mobile/keyboard affordances and local QR sharing.
- [x] Test observable client behavior and real curl transfers.
- [x] Complete actual Chrome UI transfers after the user enabled extension file access: large Unicode, multiple receivers, empty file, cancellation/recovery, reload/reselection and receiver-first browser-to-curl.
- [x] Resolve independent review findings.

## Task 3: Deployment and end-to-end evidence

**Own:** package/lock, Dockerfile, compose/proxy examples, README, test/benchmark scripts, audit report.

- [x] Set reproducible runtime/dependencies and test/typecheck commands; install dependencies.
- [x] Supply runnable Docker Compose, health check, persistent metadata volume, reverse proxy and self-hosting instructions.
- [x] Measure local transfer integrity/throughput and process memory with synthetic large payloads and multiple receivers.
- [x] Test live reference transfer with synthetic data; document feature-by-feature parity and remaining limits.
- [x] Run complete test suite, type check, curl/CLI/browser flows and available Docker validation.
- [x] Obtain Opus 5.5 Max review of final changes and fix actionable findings.

## Progress

- Initial repository: 64e8756. No tests or test script. Bun 1.4.0, Node 26.13.0 and curl 8.21.0 are installed locally.
- Opus independent initial review and frontend audit dispatched. Reference UI and public protocol inspected.
- Baseline evidence: 13 initial real-HTTP regressions and six frontend behavioral regressions failed before fixes. Independent Opus reproduced filesystem disclosure, capability forgery, Unicode failure and the 128 MiB body cap.
- Verified live reference: 4 MiB API transfer, SHA-256 exact, 1.859 seconds. Local relay: 1 GiB to three receivers, all hashes exact, 6.80 seconds, sampled peak RSS 64.67 MiB. Docker/nginx: 256 MiB to two receivers, all hashes exact.
- A node:http transport preserves Content-Length, with 18 focused Windows/Linux socket tests after the eager-Wget redirect fix. Independent QR decoding caught and fixed per-row HTTP whitespace trimming.
- Closing review completed: Opus accepted all blocking fixes, including receiver-departure recovery, creator/resource fairness, continuous idle grace, SQLite write latency, GNU Wget cancellation, static-proxy trust and large response headers.
- Final verification: Windows 95 passed/3 explicit GNU Wget skips/0 failed; Linux 98 passed/0 skipped/0 failed; typecheck, JS syntax, diff and dependency audit passed. An additional no-published-port compose smoke verified long-domain/max-Unicode CLI and prepared stdin with matching hashes.
- Actual Chrome verified three 136 MiB Unicode downloads (including automatic recovery after a cancelled receiver), an empty file, safe reload/reselection, QR rendering, mobile-width layout and receiver-first sending to curl. Physical mobile hardware/Safari and an Indian WAN deployment remain unverified and are not claimed.
- No changes have been pushed, merged, or deployed to a public host. Test containers, volumes and synthetic downloads have been cleaned up.
