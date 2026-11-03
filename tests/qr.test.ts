import { expect, test } from "bun:test";
import { connect } from "node:net";
import * as qr from "../src/qr";
import { serveHttp } from "../src/http-server";
import jsQR from "jsqr";

function readTerminalQr(rows: string[]) {
  const scale = 8;
  const width = Math.max(...rows.map(row => row.length));
  const height = rows.length * 2;
  const pixels = new Uint8ClampedArray(width * scale * height * scale * 4).fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const character = rows[Math.floor(y / 2)]?.[x] ?? " ";
      const dark = character === "█" || character === (y % 2 === 0 ? "▀" : "▄");
      if (!dark) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const index = ((y * scale + dy) * width * scale + x * scale + dx) * 4;
        pixels[index] = pixels[index + 1] = pixels[index + 2] = 0;
      }
    }
  }
  return jsQR(pixels, width * scale, height * scale)?.data;
}

test("terminal QR survives HTTP header encoding and keeps separate aligned rows", async () => {
  const headers = await qr.qrHeaders("http://localhost:3070/r/receiver-capability");
  const server = await serveHttp({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024,
    fetch: () => new Response(null, { headers: { ...headers, connection: "close" } }),
  });
  try {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = connect(server.port, "127.0.0.1", () => {
        socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      });
      socket.setTimeout(3000, () => socket.destroy(new Error("QR response timed out")));
      socket.on("data", chunk => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
      socket.on("end", () => resolve(Buffer.concat(chunks)));
      socket.on("error", reject);
    });
    const wire = raw.toString("utf8");
    const rows = wire.split("\r\n").filter(line => /^x-airshare-human-qr-\d\d:/.test(line));
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every(line => /^x-airshare-human-qr-\d\d: \|[ █▀▄]*\|$/.test(line))).toBe(true);
    expect(rows.join("\n")).toContain("█");
    expect(wire).not.toContain("\uFFFD");
    expect(wire).not.toContain("receiver-capability");
    const qrRows = rows.map(row => row.replace(/^x-airshare-human-qr-\d\d: /, "").replace(/^\|/, "").replace(/\|$/, ""));
    // Independent decoder catches per-row whitespace trimming, which makes the
    // terminal code unscannable even when every Unicode glyph survives HTTP.
    expect(readTerminalQr(qrRows)).toBe("http://localhost:3070/r/receiver-capability");
  } finally { await server.stop(true); }
});
