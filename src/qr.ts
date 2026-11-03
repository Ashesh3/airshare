import QRCode from "qrcode";

/** Generate on this host: share capabilities never leave AirShare for a QR service. */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 4 });
}

/** Plain Unicode output is safe in a response body and needs no ANSI support. */
export function qrTerminal(text: string): Promise<string> {
  return QRCode.toString(text, { type: "utf8", errorCorrectionLevel: "M", margin: 4 });
}

/**
 * curl -L discards redirect bodies, but -D - prints these rows immediately.
 * Fetch Headers accepts Latin-1 code units; Bun writes those bytes unchanged.
 * Encoding each UTF-8 row as Latin-1 preserves the block glyphs on the wire.
 * Numbered names keep rows separate (Headers combines duplicate field names).
 * Guards preserve each row's quiet zone: Headers trims outer ASCII whitespace.
 */
export async function qrHeaders(text: string): Promise<Record<string, string>> {
  const rows = (await qrTerminal(text)).split("\n");
  return Object.fromEntries(rows.map((row, index) => [
    `x-airshare-human-qr-${String(index).padStart(2, "0")}`,
    Buffer.from(`|${row}|`, "utf8").toString("latin1"),
  ]));
}
