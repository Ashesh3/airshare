import { createAdmission } from "./admission";
import { cleanupExpired, flushDeletes, persist, protectedChannel, register } from "./channels";
import type { Config } from "./config";
import type { App } from "./context";
import { serveHttp } from "./http-server";
import { MetadataStore } from "./metadata-store";
import { failReceiver } from "./relay";
import { attempt, HttpError, json } from "./responses";
import { answer, corsReadable } from "./routes";
import { holdHashWorker } from "./transfer-hash";

export type RelayServer = {
  port: number;
  /**
   * Saves channel metadata, answers waiting transfers with 503, ends status streams and stops listening; connections
   * still open after 500 ms are cut. The last relay in the process to stop also ends the hash worker. Resolves once
   * the listener has closed.
   */
  shutdown: () => Promise<void>;
};

/** One relay's state with its saved shares loaded, but no listener or cleanup timer. */
export function createApp(config: Config): App {
  const app: App = {
    config,
    store: new MetadataStore(config.dataDir),
    admission: createAdmission(config),
    channels: new Map(),
    capabilities: new Map(),
    trackers: new Map(),
    clientChannelCounts: new Map(),
    closedKeys: new Map(),
    receiverCount: 0,
    subscriberCount: 0,
    stopping: false,
    storeClosed: false,
    pendingDeletes: new Set(),
    blockedReceivers: new Set(),
  };
  for (const metadata of app.store.load(Date.now() - config.channelTtl, config.maxChannels)) register(app, metadata);
  return app;
}

/** Starts one relay with its own state, store and listener, so tests can run several in one process. */
export async function createServer(config: Config): Promise<RelayServer> {
  const app = createApp(config);
  const cleanupTimer = setInterval(() => cleanupExpired(app), config.cleanupInterval);
  cleanupTimer.unref();
  let server: Awaited<ReturnType<typeof serveHttp>>;
  try {
    // Bun's native HTTP writer drops Content-Length for live response streams.
    // The node:http adapter retains framing while keeping bounded Web streams.
    server = await serveHttp({
      hostname: config.hostname,
      port: config.port,
      maxRequestBodySize: config.maxRequestBodySize,
      clientKey: app.admission.clientIdentity,
      maxDiscards: config.maxDiscards,
      maxDiscardsPerClient: config.maxDiscardsPerClient,
      livenessHints: config.livenessHints,
      async fetch(request) {
        const response = await answer(app, request);
        if (corsReadable(request)) response.headers.set("access-control-allow-origin", "*");
        return response;
      },
      error() {
        return json({ error: "Internal server error" }, 500);
      },
    });
  } catch (error) {
    // A relay that can't listen (EADDRINUSE) must not keep its database open or its timers running.
    app.stopping = true;
    clearInterval(cleanupTimer);
    for (const channel of app.channels.values()) {
      clearTimeout(channel.hostTimer);
      clearTimeout(channel.leaseTimer);
    }
    app.storeClosed = true;
    app.store.close();
    throw error;
  }
  const releaseHashWorker = holdHashWorker();
  let stopped: Promise<void> | undefined;
  const shutdown = () => {
    if (stopped) return stopped;
    // Record activity before touches are disabled, or a hosted channel restarts with a stale lifetime.
    const now = Date.now();
    for (const channel of app.channels.values()) {
      if (protectedChannel(channel)) {
        channel.lastProtectedAt = now;
        channel.lastTouched = now;
      }
      // A full disk must not stop the answers, the listener or the hash worker below.
      attempt(() => persist(app, channel));
    }
    app.stopping = true;
    clearInterval(cleanupTimer);
    // Every open stream and waiting transfer ends now with an answer, rather than only when its socket is torn down.
    const restarting = new HttpError(503, "The server is restarting; retry shortly", "stopping", 5);
    for (const channel of app.channels.values()) {
      clearTimeout(channel.hostTimer);
      clearTimeout(channel.leaseTimer);
      channel.upload?.abort.abort(restarting);
      for (const receiver of [...channel.waiting]) failReceiver(app, receiver, restarting, "stopping", 503);
      for (const subscriber of [...channel.subscribers]) subscriber.sse.finish();
    }
    for (const tracker of app.trackers.values()) tracker.sse.finish();
    flushDeletes(app);
    app.storeClosed = true;
    attempt(() => app.store.close());
    // The answers just queued get a moment to reach their clients before the remaining sockets are cut.
    stopped = Promise.all([server.stop(true, 500), releaseHashWorker()]).then(() => undefined);
    return stopped;
  };
  return { port: server.port, shutdown };
}
