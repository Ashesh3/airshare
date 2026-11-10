import {
  channelPayload,
  closeChannel,
  createChannel,
  lookup,
  missing,
  noteProtection,
  origin,
  persist,
  setLease,
} from "./channels";
import { cliEntry } from "./cli";
import type { App, Role, Tracker } from "./context";
import { fileDetails } from "./filenames";
import { renderClosedPage, renderPage, renderShell, serveStatic, wantsHtml, type ShellView } from "./pages";
import { qrSvg, qrTerminal } from "./qr";
import { download, handleUpload } from "./relay";
import { asError, commonHeaders, HttpError, json, notFound, readJson, record, withRetryAfter } from "./responses";
import { stationDetails, transferOptions } from "./station";
import { hostingParameter, nativeEvents, presence, subscribe, track, unsubscribe } from "./streams";

/** Only downloads and status reads are readable cross-origin; nothing that creates, changes or deletes a share is. */
const corsReadPath = new RegExp(
  `^/(?:${[
    "healthz",
    "(?:l|download)/[^/]+(?:/.*)?",
    "api/channels/[^/]+",
    "api/v1/channel/(?:sender|receiver)/[^/]+",
    "api/v1/channel/receiver/[^/]+/download(?:/.*)?",
  ].join("|")})$`,
);
export function corsReadable(request: Request) {
  return (
    (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") &&
    corsReadPath.test(new URL(request.url).pathname)
  );
}
/**
 * Browsers always send Origin on cross-origin writes; terminal clients send none. A page may be served from a host
 * other than PUBLIC_URL (localhost, a LAN address, a proxy port), so its own Host also counts, as does the
 * X-Forwarded-Host a trusted proxy reports. The scheme isn't compared: a TLS proxy turns https into http.
 */
function sameOrigin(app: App, request: Request) {
  const value = request.headers.get("origin");
  if (value === null) return true;
  let sent: URL;
  try {
    sent = new URL(value);
  } catch {
    return false;
  }
  if (sent.origin === origin(app, request)) return true;
  // A host without a port names the default port of the page's scheme, so another port on the same name is another site.
  const seen = (host: string | null | undefined) => {
    if (!host) return;
    try {
      return new URL(`${sent.protocol}//${host}`);
    } catch {
      return;
    }
  };
  if (seen(request.headers.get("host"))?.host === sent.host) return true;
  if (!app.admission.viaTrustedProxy(request)) return false;
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const reported = seen(forwarded);
  if (!reported) return false;
  // A trusted proxy that forwards a bare hostname (nginx's $host) has dropped the port the page used.
  return reported.host === sent.host || (!/:\d+$/.test(forwarded!) && reported.hostname === sent.hostname);
}
async function qrCode(app: App, request: Request, url: URL) {
  const input = url.searchParams.get("url");
  if (!input || input.length > 2048)
    throw new HttpError(400, "A same-origin share URL of at most 2048 characters is required");
  let target: URL;
  try {
    target = new URL(input);
  } catch {
    throw new HttpError(400, "Invalid QR URL");
  }
  if (
    !/^https?:$/.test(target.protocol) ||
    target.username ||
    target.password ||
    target.origin !== origin(app, request)
  ) {
    throw new HttpError(400, "QR URLs must use this server's public origin");
  }
  const terminal = url.searchParams.get("format") === "terminal";
  const body = request.method === "HEAD" ? null : terminal ? await qrTerminal(target.href) : await qrSvg(target.href);
  return new Response(body, {
    headers: {
      ...commonHeaders,
      "content-type": terminal ? "text/plain; charset=utf-8" : "image/svg+xml; charset=utf-8",
    },
  });
}
async function createFromApi(app: App, request: Request, path: string) {
  const body = record(await readJson(app, request), "Channel request");
  const station = path === "/api/v1/channel";
  const file = fileDetails(station ? (body.file_details === undefined ? {} : body.file_details) : body, station);
  if (!station && body.hostBound !== undefined && typeof body.hostBound !== "boolean")
    throw new HttpError(400, "hostBound must be a boolean");
  let tracking: { tracker: Tracker; tag?: string; role: Role; hosting: boolean } | undefined;
  if (station && body.tracker !== undefined) {
    const details = record(body.tracker, "tracker");
    if (
      typeof details.tracker_key !== "string" ||
      (details.tag !== undefined && (typeof details.tag !== "string" || details.tag.length > 256))
    ) {
      throw new HttpError(400, "Invalid tracker metadata");
    }
    const perspective = details.perspective ?? "channel";
    if (perspective !== "channel" && perspective !== "sender" && perspective !== "receiver")
      throw new HttpError(400, "Invalid tracker perspective");
    if (details.hosting !== undefined && typeof details.hosting !== "boolean")
      throw new HttpError(400, "tracker.hosting must be a boolean");
    const tracker = app.trackers.get(details.tracker_key);
    if (!tracker) throw new HttpError(404, "Tracker not found");
    if (tracker.subscriptions.size >= app.config.maxTrackerChannels)
      throw new HttpError(429, "Subscription limit reached", "subscription_limit");
    tracking = {
      tracker,
      tag: details.tag as string | undefined,
      role: perspective === "channel" ? "owner" : perspective,
      hosting: details.hosting === true,
    };
  }
  // A Station-style page tracker owns its channel the way a hosting tab does.
  const channel = createChannel(app, request, file, station ? tracking?.role === "owner" : body.hostBound === true);
  if (tracking) subscribe(app, tracking.tracker, { channel, role: tracking.role }, tracking);
  return station
    ? json(stationDetails(channel, "owner", origin(app, request)))
    : json(channelPayload(channel, "owner", origin(app, request)), 201);
}
async function route(app: App, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  decodeURIComponent(path);
  const read = request.method === "GET" || request.method === "HEAD";
  const write = request.method === "POST" || request.method === "PUT";
  // After shutdown begins, closing a channel would only change memory, and it would return after a restart.
  if (app.stopping) throw new HttpError(503, "The server is restarting; retry shortly", "stopping", 5);
  if (request.method === "OPTIONS") {
    const cors: Record<string, string> = corsReadable(request) ? { "access-control-allow-methods": "GET, HEAD" } : {};
    return new Response(null, { status: 204, headers: { ...commonHeaders, ...cors } });
  }
  if (!read && !sameOrigin(app, request))
    throw new HttpError(403, "Requests from other websites can't create, change or delete shares", "cross_origin");
  if (read && path === "/healthz") return json({ status: "ok" });
  if (read && path === "/api/qr") return qrCode(app, request, url);
  if (request.method === "POST" && (path === "/api/channels" || path === "/api/v1/channel"))
    return createFromApi(app, request, path);
  if (request.method === "GET" && path === "/api/v1/track") return track(app, request);
  if (request.method === "POST" && path === "/api/presence") return presence(app, request);
  const subscription = path.match(/^\/api\/v1\/channel\/(?:(sender|receiver)\/)?([^/]+)\/subscribe\/([^/]+)$/);
  if ((request.method === "POST" || request.method === "DELETE") && subscription) {
    const role = (subscription[1] ?? "owner") as Role;
    const key = decodeURIComponent(subscription[2]!);
    const capability = lookup(app, key, [role]);
    if (!capability) return missing(app, key, [role]);
    const tracker = app.trackers.get(decodeURIComponent(subscription[3]!));
    if (!tracker) return notFound();
    if (request.method === "DELETE") {
      unsubscribe(app, tracker, capability);
      return new Response(null, { status: 204, headers: commonHeaders });
    }
    subscribe(app, tracker, capability, { hosting: hostingParameter(url) });
    return new Response(null, { status: 200, headers: { ...commonHeaders, "content-length": "0" } });
  }
  // Native subscriptions accept any role's key and answer with that key's current status.
  const nativeSubscription = path.match(/^\/api\/channels\/([^/]+)\/subscribe\/([^/]+)$/);
  if ((request.method === "POST" || request.method === "DELETE") && nativeSubscription) {
    const key = decodeURIComponent(nativeSubscription[1]!);
    const capability = lookup(app, key);
    if (!capability) return missing(app, key);
    const tracker = app.trackers.get(decodeURIComponent(nativeSubscription[2]!));
    if (!tracker) throw new HttpError(404, "Tracker not found", "tracker_not_found");
    if (request.method === "DELETE") {
      unsubscribe(app, tracker, capability);
      return new Response(null, { status: 204, headers: commonHeaders });
    }
    subscribe(app, tracker, capability, { hosting: hostingParameter(url) });
    return json(channelPayload(capability.channel, capability.role, origin(app, request)));
  }
  const station = path.match(/^\/api\/v1\/channel\/(sender|receiver)\/([^/]+)(?:\/(upload|download)(?:\/.*)?)?$/);
  if (station) {
    const role = station[1] as "sender" | "receiver";
    const key = decodeURIComponent(station[2]!);
    const capability = lookup(app, key, [role]);
    if (!capability) return missing(app, key, [role]);
    if (read && !station[3]) return json(stationDetails(capability.channel, role, origin(app, request)));
    if (write && role === "sender" && station[3] === "upload")
      return handleUpload(app, request, capability.channel, transferOptions(request));
    if (read && role === "receiver" && station[3] === "download")
      return download(app, request, capability.channel, transferOptions(request));
    return notFound();
  }
  const native = path.match(/^\/api\/channels\/([^/]+)(?:\/(events|upload)(?:\/(.*))?)?$/);
  if (native) {
    const key = decodeURIComponent(native[1]!);
    const capability = lookup(app, key);
    if (!capability) return missing(app, key);
    const { channel, role } = capability;
    if (read && !native[2]) {
      if (role !== "receiver") {
        const presence = request.headers.get("x-airshare-sender-presence");
        if (presence === "1") {
          setLease(app, channel, Date.now() + app.config.senderLease);
          noteProtection(app, channel);
        } else if (presence === "0") {
          if (channel.senderLeaseUntil > Date.now()) noteProtection(app, channel);
          setLease(app, channel, 0);
          persist(app, channel);
        }
      }
      return json(channelPayload(channel, role, origin(app, request)));
    }
    if (request.method === "GET" && native[2] === "events" && native[3] === undefined)
      return nativeEvents(app, request, capability);
    if (request.method === "DELETE" && !native[2] && role === "owner") {
      // A closing sender tab reports sender_left so receivers aren't told the share was deleted.
      const requested = url.searchParams.get("reason");
      if (requested !== null && requested !== "sender_left")
        throw new HttpError(400, "reason must be sender_left when present");
      closeChannel(app, channel, requested === "sender_left" ? "sender_left" : "deleted");
      return new Response(null, { status: 204, headers: commonHeaders });
    }
    if (write && native[2] === "upload" && role !== "receiver")
      return handleUpload(app, request, channel, transferOptions(request));
    return notFound();
  }
  // Short transfer links; the longer /download, /api/channels/…/upload and Station routes remain aliases.
  const short = path.match(/^\/(l|u)\/([^/]+)(?:\/.*)?$/);
  if (short) {
    const receiving = short[1] === "l";
    if (receiving ? !read : !write) {
      const headers = {
        ...commonHeaders,
        allow: receiving ? "GET, HEAD" : "POST, PUT",
        "content-type": "text/plain; charset=utf-8",
      };
      return new Response(`Use ${receiving ? "GET" : "POST or PUT"} on this transfer link.\n`, {
        status: 405,
        headers,
      });
    }
    const key = decodeURIComponent(short[2]!);
    const allowed: Role[] = receiving ? ["receiver"] : ["owner", "sender"];
    const capability = lookup(app, key, allowed);
    if (!capability) return missing(app, key, allowed);
    return receiving
      ? download(app, request, capability.channel, transferOptions(request))
      : handleUpload(app, request, capability.channel, transferOptions(request));
  }
  const downloading = path.match(/^\/download\/([^/]+)(?:\/.*)?$/);
  if (read && downloading) {
    const key = decodeURIComponent(downloading[1]!);
    const capability = lookup(app, key, ["receiver"]);
    return capability
      ? download(app, request, capability.channel, transferOptions(request))
      : missing(app, key, ["receiver"]);
  }
  const pageUpload = write && path.match(/^\/(r|recv|s|send)\/([^/]+)(?:\/.*)?$/);
  if (pageUpload) {
    const key = encodeURIComponent(decodeURIComponent(pageUpload[2]!));
    const hint = pageUpload[1]!.startsWith("s")
      ? `This is a browser page. Upload to its transfer link instead: curl -T <file> ${origin(app, request)}/u/${key}/`
      : `This is a browser page for downloading. Download with: curl -JLO ${origin(app, request)}/l/${key}`;
    const headers = {
      ...commonHeaders,
      allow: "GET, HEAD",
      "content-type": "text/plain; charset=utf-8",
      "x-airshare-human-info": hint,
    };
    return new Response(`${hint}\n`, { status: 405, headers });
  }
  const page = path.match(/^\/(r|recv|s|send)\/([^/]+)$/);
  if (read && page) {
    const role = page[1] === "r" || page[1] === "recv" ? "receiver" : "sender";
    const key = decodeURIComponent(page[2]!);
    const capability = lookup(app, key, [role]);
    return capability
      ? renderPage(app, request, capability.channel, role, key)
      : renderClosedPage(app, request, role, key);
  }
  if (read && /^\/(recipes|about|privacy|license)$/.test(path))
    return renderShell(app, request, path.slice(1) as ShellView);
  // Receiving starts only from `/` or `/xfr…` with GET, so probes and typos never create channels.
  // Uploads keep the whole path space: `curl -T file <host>` sends PUT /file.
  const cli = /^(curl|Wget)\//i.test(request.headers.get("user-agent") ?? "");
  const entry = path === "/xfr" || path.startsWith("/xfr/") || (path === "/" && cli);
  if (entry && request.method === "GET") return cliEntry(app, request, path, true);
  if (entry && write) return cliEntry(app, request, path, false);
  if (read && (path === "/" || path === "/index.html")) return renderShell(app, request, "home");
  const generic = !/^\/(api|download|l|u|r|recv|s|send)(\/|$)/.test(path);
  if (generic && write) return cliEntry(app, request, path, false);
  if (read) {
    const asset = await serveStatic(path, request.method === "HEAD");
    if (asset.status !== 404) return asset;
    return wantsHtml(request) ? renderShell(app, request, "notfound", { status: 404 }) : asset;
  }
  return notFound();
}
export async function answer(app: App, request: Request) {
  try {
    return await route(app, request);
  } catch (error) {
    if (error instanceof URIError) return json({ error: "Malformed URL encoding" }, 400);
    if (error instanceof HttpError)
      return withRetryAfter(
        json({ error: error.message, reason: error.reason, retryable: false }, error.status),
        error,
      );
    if (request.signal.aborted) return json({ error: "Request cancelled" }, 499);
    console.error("Request failed", asError(error).message);
    return json({ error: "Internal server error" }, 500);
  }
}
