// The host's one HTTP server. It carries three surfaces the browser uses: a WebSocket at /ws for the
// control protocol, a media proxy at /media for audio the Web Audio graph can decode cross-origin, and
// /health for liveness. Each WebSocket connection gets its own bridge Session. The episode server is
// reached only through the shared MCP client, never from the browser.

import { createServer } from "node:http";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { Session } from "./bridge.js";
import type { RunMode } from "./bridge.js";
import { handleMedia } from "./media-proxy.js";
import type { OverhearClient } from "./mcp-client.js";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import type { Event } from "./protocol.js";

const HEALTH_TIMEOUT_MS = 5_000;

/** Read the episode server's run mode so the UI can label mock vs live and the producer fallback. */
export async function fetchRunMode(serverOrigin: string, log: Logger): Promise<RunMode> {
  try {
    const res = await fetch(`${serverOrigin}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body: unknown = await res.json();
    const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const mode = o.mode === "aws" ? "aws" : "mock";
    const store = o.store === "aws" ? "aws" : "local";
    return { mode, store };
  } catch (err) {
    log.warn("health check failed, assuming mock mode", { error: String(err) });
    return { mode: "mock", store: "local" };
  }
}

export type RunningServer = { close: () => Promise<void> };

export function startServer(
  client: OverhearClient,
  config: Config,
  log: Logger,
  mode: RunMode,
): Promise<RunningServer> {
  const http: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname.startsWith("/media/")) {
      void handleMedia(req, res, config, log);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  const wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (socket: WebSocket) => {
    const send = (event: Event): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };
    const session = new Session(send, client, config, log, mode);
    session.start();
    socket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        log.warn("dropped non-JSON frame");
        return;
      }
      void session.handle(parsed);
    });
    socket.on("close", () => session.dispose());
    socket.on("error", (err) => log.warn("socket error", { error: String(err) }));
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, config.host, () => {
      http.off("error", reject);
      log.info("simulator host listening", { host: config.host, port: config.port });
      resolve({
        close: () =>
          new Promise<void>((res) => {
            wss.close(() => http.close(() => res()));
          }),
      });
    });
  });
}
