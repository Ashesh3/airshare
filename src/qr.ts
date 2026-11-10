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
 * Rows for repeated `com.station307.human.qr-code` headers, which `curl -D -` prints before following a redirect.
 * HTTP trims the outer spaces of a header value, so each row's quiet zone ends in no-break spaces instead.
 * node:http writes header strings as Latin-1, so each UTF-8 row is passed as Latin-1 code units.
 */
export async function qrHeaderRows(text: string): Promise<string[]> {
  const rows = (await qrTerminal(text)).split("\n").filter((row) => row.length > 0);
  return rows.map((row) =>
    Buffer.from(
      row.replace(/^ +| +$/g, (spaces) => "\u00a0".repeat(spaces.length)),
      "utf8",
    ).toString("latin1"),
  );
}
