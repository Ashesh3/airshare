import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { channelPayload, closedRecord, origin } from "./channels";
import { closeMessages, type App, type Channel, type CloseReason } from "./context";
import { commonHeaders, notFound } from "./responses";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}
const shellTitles = {
  home: "AirShare",
  recipes: "AirShare Recipes",
  about: "AirShare About",
  privacy: "AirShare Privacy",
  license: "AirShare License",
  receiver: "AirShare Download",
  send: "AirShare Upload",
  notfound: "AirShare Page Not Found",
} as const;
export type ShellView = keyof typeof shellTitles;
type ShellBootstrap = {
  key: string;
  role: "sender" | "receiver";
  channel?: ReturnType<typeof channelPayload>;
  closedReason?: CloseReason | "not_found";
};
let shellTemplate: Promise<string> | undefined;
function htmlHeaders(app: App) {
  const connect = app.config.publicOrigin ? `'self' ${app.config.publicOrigin}` : "'self'";
  const policy =
    `default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src ${connect}; ` +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  return {
    ...commonHeaders,
    "content-type": "text/html; charset=utf-8",
    "cross-origin-opener-policy": "same-origin",
    "content-security-policy": policy,
  };
}
export function wantsHtml(request: Request) {
  return /\btext\/html\b/i.test(request.headers.get("accept") ?? "");
}
function closedText(reason: CloseReason | "not_found") {
  return reason === "sender_left" ? closeMessages.sender_left : "This share is no longer available.";
}
// Every browser page is one shell document; the server only reveals the requested view so it renders without a flash.
export async function renderShell(
  app: App,
  request: Request,
  view: ShellView,
  options: { status?: number; bootstrap?: ShellBootstrap; filename?: string } = {},
) {
  shellTemplate ??= Bun.file(resolve(publicRoot, "index.html")).text();
  const base = escapeHtml(origin(app, request));
  let html = (await shellTemplate)
    .replace("<title>AirShare</title>", () => `<title>${shellTitles[view]}</title>`)
    .replace(`data-view="${view}" hidden`, () => `data-view="${view}"`)
    .replaceAll("{{origin}}", () => base)
    .replace("{{year}}", () => String(new Date().getUTCFullYear()));
  // The header or footer link of the current page; views without one (a share page, the 404) match nothing.
  html = html.replace(`data-nav="${view}"`, () => `data-nav="${view}" class="active" aria-current="page"`);
  const { bootstrap } = options;
  if (bootstrap) {
    const statusId = bootstrap.role === "sender" ? "send-status" : "receiver-status";
    if (bootstrap.closedReason) {
      html = html
        .replace(`id="${statusId}" class="transfer-status"`, () => `id="${statusId}" class="transfer-status has-error"`)
        .replace(
          `id="${statusId}" class="transfer-status has-error" role="status" aria-live="polite">`,
          (match) => `${match}${escapeHtml(closedText(bootstrap.closedReason!))}`,
        );
    }
    if (bootstrap.role === "receiver" && bootstrap.channel && options.filename !== undefined) {
      const downloadUrl = escapeHtml(bootstrap.channel.downloadUrl);
      html = html
        .replace(
          'id="receiver-alert" class="receiver-alert" hidden',
          () => 'id="receiver-alert" class="receiver-alert"',
        )
        .replace('id="receiver-file-name">', () => `id="receiver-file-name">${escapeHtml(options.filename!)}`)
        .replace(
          'id="download" class="primary" aria-disabled="true"',
          () => `id="download" class="primary" href="${downloadUrl}"`,
        );
    }
    const data = JSON.stringify(bootstrap).replace(/</g, "\\u003c");
    html = html.replace(
      "<!--airshare-bootstrap-->",
      () => `<script type="application/json" id="airshare-channel">${data}</script>`,
    );
  }
  return new Response(request.method === "HEAD" ? null : html, {
    status: options.status ?? 200,
    headers: htmlHeaders(app),
  });
}
export function renderPage(app: App, request: Request, channel: Channel, role: "sender" | "receiver", key: string) {
  const bootstrap: ShellBootstrap = { key, role, channel: channelPayload(channel, role, origin(app, request)) };
  return renderShell(app, request, role === "sender" ? "send" : "receiver", {
    bootstrap,
    filename: channel.file.filename,
  });
}
export function renderClosedPage(app: App, request: Request, role: "sender" | "receiver", key: string) {
  const record = closedRecord(app, key);
  const reason = record?.role === role ? record.reason : undefined;
  const bootstrap: ShellBootstrap = { key, role, closedReason: reason ?? "not_found" };
  return renderShell(app, request, role === "sender" ? "send" : "receiver", { status: reason ? 410 : 404, bootstrap });
}
export async function serveStatic(pathname: string, head: boolean) {
  const decoded = decodeURIComponent(pathname);
  if (/[\\\u0000:]/.test(decoded) || decoded.startsWith("//") || decoded.split("/").includes("..")) return notFound();
  // HTML is only ever served through renderShell, which fills in the view, headers and CSP.
  if (decoded === "/" || /\.html?$/i.test(decoded)) return notFound();
  const path = resolve(publicRoot, `.${decoded}`);
  const inside = (target: string) => {
    const rel = relative(publicRoot, target);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!inside(path)) return notFound();
  try {
    if (!inside(await realpath(path)) || !(await stat(path)).isFile()) return notFound();
    const file = Bun.file(path);
    const headers = {
      ...commonHeaders,
      "content-type": file.type || "application/octet-stream",
      "content-length": String(file.size),
    };
    return new Response(head ? null : file, { headers });
  } catch {
    return notFound();
  }
}
