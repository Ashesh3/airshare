import { channelPayload, createChannel, keyFor, noteProtection, origin, persist, unnamed } from "./channels";
import type { App, Channel } from "./context";
import { fileDetails, headerFilename, terminalFilename, timestampedName } from "./filenames";
import { onRequestFinished, withRepeatedHeaders } from "./http-server";
import { qrHeaderRows } from "./qr";
import { commonHeaders, headerSize, HttpError, json, streamHeaders } from "./responses";
import { notify } from "./streams";

const HUMAN_INFO = "Copy one of the two URLs, or scan the QR code";
/**
 * Header names containing "human" are what `| grep human` shows: the two links to share, their QR code and an info line.
 * Sending shares receiver links. A receive-first request shares sender links, because the person it asks must upload.
 */
function cliHeaders(app: App, request: Request, channel: Channel, receiving: boolean) {
  const base = origin(app, request);
  // The sender view has every link a terminal needs, and after a restart the owner key may be unknown.
  const payload = channelPayload(channel, "sender", base);
  // Until a sender names the file, an upload URL ending in "/" lets curl -T append the local file name.
  const uploadUrl = unnamed(channel) ? payload.uploadUrl!.replace(/[^/]*$/, "") : payload.uploadUrl!;
  const senderPage = `${base}/send/${keyFor(channel, "sender")}`;
  const web = receiving ? senderPage : payload.humanUrl;
  const transfer = receiving ? uploadUrl : payload.downloadUrl;
  return {
    "com.station307.human.info": HUMAN_INFO,
    "x-airshare-human-info": HUMAN_INFO,
    "com.station307.human.transfer.url": transfer,
    "com.station307.human.web.url": web,
    "com.station307.transfer.url": transfer,
    "com.station307.url": transfer,
    "com.station307.located-at": transfer,
    "x-airshare-download-url": payload.downloadUrl,
    "x-airshare-upload-url": uploadUrl,
    ...(receiving
      ? { "x-airshare-sender-page-url": senderPage }
      : { "x-airshare-receiver-page-url": payload.humanUrl }),
    "x-airshare-qr-url": `${base}/api/qr?url=${encodeURIComponent(web)}`,
  };
}
/** `curl -s … | grep human` hides the body, so the instruction is also a header whose name contains "human". */
function prepareRequired(app: App, request: Request, pathname: string) {
  // The command quotes the URL in single quotes, which only a literal "'" can end.
  const prepareUrl = `${origin(app, request)}${pathname}?prepare=1`.replaceAll("'", "%27");
  const hint =
    "A pipe can't be resent after a redirect, so prepare its upload URL first: " +
    `UPLOAD_URL=$(curl -fsS -X POST -D /dev/stderr '${prepareUrl}'), then pipe into: curl -T - "$UPLOAD_URL"`;
  const response = json({ error: hint, reason: "prepare_required", retryable: false }, 411);
  response.headers.set("x-airshare-human-info", hint);
  return response;
}
/**
 * Any web page can make its visitors' browsers GET a URL (an image, a frame, a link), and over plain HTTP browsers send
 * no Sec-Fetch-Site, so a receive started by a GET refuses browsers outright. PowerShell's Invoke-WebRequest also sends
 * a Mozilla/ User-Agent, but names itself in it.
 */
function browserGet(request: Request) {
  const agent = request.headers.get("user-agent") ?? "";
  return agent.startsWith("Mozilla/") && !agent.includes("PowerShell");
}
export async function cliEntry(app: App, request: Request, pathname: string, receiving: boolean) {
  if (receiving && browserGet(request)) {
    // Someone who opened the address in a browser gets the home page rather than an error.
    if (/\btext\/html\b/i.test(request.headers.get("accept") ?? "")) {
      return new Response(null, { status: 303, headers: { ...commonHeaders, location: "/", "content-length": "0" } });
    }
    throw new HttpError(
      403,
      "Browsers can't start a terminal receive; open the home page to share a file",
      "browser_entry",
    );
  }
  const prepare = new URL(request.url).searchParams.get("prepare") === "1";
  const requestLength = headerSize(request.headers.get("content-length"), "Content-Length");
  if (
    prepare &&
    (request.method !== "POST" ||
      request.headers.has("transfer-encoding") ||
      (requestLength !== undefined && requestLength !== 0))
  ) {
    throw new HttpError(400, "Prepare a channel using POST with no file body");
  }
  if (!receiving && !prepare && requestLength === undefined) return prepareRequired(app, request, pathname);
  // Only "/xfr" itself is the entry: "/xfr_log.txt" or "/xfr.tar.gz" is a file name.
  const name = (pathname === "/xfr" ? "" : pathname.startsWith("/xfr/") ? pathname.slice(4) : pathname)
    .split("/")
    .filter(Boolean)
    .at(-1);
  const supplied = headerFilename(request) ?? (name ? decodeURIComponent(name) : undefined);
  const filename = supplied !== undefined ? terminalFilename(supplied) : receiving ? undefined : timestampedName();
  const transportType = request.headers.get("content-type");
  const defaultWgetType =
    /^Wget\//i.test(request.headers.get("user-agent") ?? "") &&
    /^application\/x-www-form-urlencoded(?:;|$)/i.test(transportType ?? "");
  const contentLength = receiving || prepare ? undefined : requestLength;
  const file = fileDetails({
    filename,
    contentType: defaultWgetType ? undefined : (transportType ?? undefined),
    contentLength,
  });
  const channel = createChannel(app, request, file);
  if (!receiving && !prepare) {
    channel.creating = true;
    onRequestFinished(request, () => {
      noteProtection(app, channel);
      channel.creating = false;
      persist(app, channel);
      notify(app, channel);
    });
  }
  const headers = cliHeaders(app, request, channel, receiving);
  const qr = { "com.station307.human.qr-code": await qrHeaderRows(headers["com.station307.human.web.url"]) };
  if (prepare) {
    const body = `${headers["x-airshare-upload-url"]}\n`;
    const prepared = {
      ...streamHeaders,
      ...headers,
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
    };
    return withRepeatedHeaders(new Response(body, { status: 201, headers: prepared }), qr);
  }
  // Reply before reading the initial body so curl can follow the redirect
  // without consuming non-rewindable stdin (Expect: 100-continue).
  const location = receiving ? headers["x-airshare-download-url"] : headers["x-airshare-upload-url"];
  return withRepeatedHeaders(
    new Response(null, {
      status: 307,
      headers: { ...streamHeaders, ...headers, "content-length": "0", connection: "close", location },
    }),
    qr,
  );
}
