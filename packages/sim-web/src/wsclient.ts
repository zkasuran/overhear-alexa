// The control socket to the simulator host. It sends typed commands up and hands validated events to
// the app. A dropped connection reconnects with capped backoff and reports its state so the UI can
// show an offline panel rather than failing silently. Every incoming frame is parsed and shape-checked
// before the app sees it, because a socket is an untrusted boundary even when the other end is ours.

import { RECONNECT_MAX_MS, RECONNECT_MIN_MS, WS_URL } from "./config.js";
import type { Command, Event, EventType } from "./protocol.js";

const EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  "status",
  "ring",
  "outline",
  "part-status",
  "part-ready",
  "caption",
  "ducking",
  "answer",
  "moment",
  "time-left",
  "notice",
  "render-done",
]);

export type LinkState = "connecting" | "open" | "closed";

export type SocketHandlers = {
  onEvent: (event: Event) => void;
  onState: (state: LinkState) => void;
};

/** Validate a parsed frame as one of our events, or null when it is not a recognised shape. */
function asEvent(raw: unknown): Event | null {
  if (typeof raw !== "object" || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) return null;
  return raw as Event;
}

export class SimSocket {
  readonly #handlers: SocketHandlers;
  #ws: WebSocket | undefined;
  #backoff = RECONNECT_MIN_MS;
  #closed = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(handlers: SocketHandlers) {
    this.#handlers = handlers;
  }

  connect(): void {
    this.#closed = false;
    this.#open();
  }

  #open(): void {
    this.#handlers.onState("connecting");
    const ws = new WebSocket(WS_URL);
    this.#ws = ws;
    ws.addEventListener("open", () => {
      this.#backoff = RECONNECT_MIN_MS;
      this.#handlers.onState("open");
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const event = asEvent(parsed);
      if (event !== null) this.#handlers.onEvent(event);
    });
    ws.addEventListener("close", () => this.#scheduleRetry());
    // A socket error is followed by close; let close drive the retry so it happens once.
    ws.addEventListener("error", () => this.#handlers.onState("closed"));
  }

  #scheduleRetry(): void {
    this.#handlers.onState("closed");
    if (this.#closed) return;
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, RECONNECT_MAX_MS);
    this.#retryTimer = setTimeout(() => this.#open(), delay);
  }

  send(command: Command): void {
    const ws = this.#ws;
    if (ws !== undefined && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(command));
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#ws?.close();
  }
}
