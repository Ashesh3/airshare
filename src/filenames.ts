import type { FileDetails } from "./metadata-store";
import { encoder, HttpError, record } from "./responses";

/** The name a channel has until a sender supplies one, as in a receive-first request. */
export const UNNAMED_FILE = "airshare-download";
export function sanitizeFilename(value?: string) {
  const name = (value ?? UNNAMED_FILE).toWellFormed().split(/[\\/]/).at(-1) ?? "";
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069"]/g, "_")
    .trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : UNNAMED_FILE;
}
/** A name for a terminal send that came without one, such as `wget --post-file` to the site root. */
export function timestampedName(now = new Date()) {
  return `airshare-${now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}.bin`;
}
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const utf8Length = (text: string) => encoder.encode(text).length;
/** The whole graphemes at the start of text whose total size fits the budget. */
function fitGraphemes(text: string, budget: number, size: (text: string) => number) {
  let kept = "";
  for (const { segment } of graphemes.segment(text)) {
    const cost = size(segment);
    if (cost > budget) break;
    kept += segment;
    budget -= cost;
  }
  return kept;
}
/** Cuts a name to the limit (UTF-8 bytes by default) on whole graphemes, keeping a short extension; never just an extension. */
function shortenFilename(name: string, limit = 255, size = utf8Length) {
  if (size(name) <= limit) return name;
  const usable = (part: string) => /[^.\s]/u.test(part);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && size(name.slice(dot)) <= 32 ? name.slice(dot) : "";
  const stem = fitGraphemes(name.slice(0, name.length - extension.length), limit - size(extension), size);
  if (usable(stem)) return stem + extension;
  const whole = fitGraphemes(name, limit, size);
  return usable(whole) ? whole : UNNAMED_FILE;
}
/** A terminal name is its last path segment, cleaned like any name, then cut to 255 UTF-8 bytes instead of refused. */
export function terminalFilename(value: string) {
  return shortenFilename(sanitizeFilename(value));
}
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
/**
 * Header values arrive as Latin-1 code units. Raw UTF-8 (what `curl -H` sends) is decoded when it is valid,
 * and RFC 8187's `UTF-8''<percent-encoded>` form is accepted too.
 */
export function headerFilename(request: Request) {
  const raw = request.headers.get("x-airshare-filename") ?? request.headers.get("x-station307-filename");
  if (raw === null) return undefined;
  const extended = raw.match(/^UTF-8''(.*)$/i);
  if (extended) return decodeURIComponent(extended[1]!);
  if (!/[\x80-\xff]/.test(raw)) return raw;
  try {
    return strictUtf8.decode(Buffer.from(raw, "latin1"));
  } catch {
    return raw;
  }
}
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?: *;[\x20-\x7e]*)?$/;
export function fileDetails(value: unknown, station = false): FileDetails {
  const file = record(value, "File metadata");
  const filename = file.filename;
  const contentType = file[station ? "content_type" : "contentType"];
  const contentLength = file[station ? "content_length" : "contentLength"];
  if (
    filename !== undefined &&
    (typeof filename !== "string" || filename.length > 512 || encoder.encode(filename).length > 1024)
  ) {
    throw new HttpError(400, "filename must be a string of at most 512 characters / 1024 UTF-8 bytes");
  }
  if (
    contentType !== undefined &&
    (typeof contentType !== "string" || !/^[\x20-\x7e]{1,255}$/.test(contentType) || !MEDIA_TYPE.test(contentType))
  ) {
    throw new HttpError(400, "contentType must be a valid media type string");
  }
  if (
    contentLength !== undefined &&
    (typeof contentLength !== "number" || !Number.isSafeInteger(contentLength) || contentLength < 0)
  ) {
    throw new HttpError(400, "contentLength must be a nonnegative safe integer");
  }
  return {
    filename: sanitizeFilename(filename as string | undefined),
    contentType: (contentType as string | undefined) ?? "application/octet-stream",
    ...(contentLength !== undefined ? { contentLength: contentLength as number } : {}),
  };
}
/**
 * curl -J ignores filename* and fails on names its file system rejects, so the ASCII name is at most 255 characters.
 * A non-ASCII name falls back to a reversible percent-encoded form.
 */
function asciiFilename(filename: string) {
  if (/^[\x20-\x7e]*$/.test(filename)) return shortenFilename(filename.replace(/["\\]/g, "_"));
  const encode = (text: string) =>
    Array.from(encoder.encode(text), (byte) =>
      byte >= 0x20 && byte <= 0x7e && byte !== 0x22 && byte !== 0x25 && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    ).join("");
  return encode(shortenFilename(filename, 255, (text) => encode(text).length));
}
export function contentDisposition(filename: string) {
  const ascii = asciiFilename(filename);
  const utf8 = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
