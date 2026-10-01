// Streaming Server-Sent Events parser for the conformance CLI. Wire-level, not DOM:
// it emits a record for EVERY blank-line-terminated block, INCLUDING a priming event
// that carries only an id and an empty data field. The browser EventSource model drops
// those; the suite must observe them (C-10), so this parser keeps them.
//
// Line and field handling follows the WHATWG event-stream rules: lines end with LF, CR
// or CRLF; a leading space after the field colon is stripped; `id` values with a NUL are
// ignored; `retry` takes effect only when the value is all ASCII digits; `data` lines are
// joined with LF and a single trailing LF is removed at dispatch.

export type SseEvent = {
  /** The `id` field value seen in this block, if any. Undefined when the block carried none. */
  id?: string;
  /** The `event` field value, if any. Undefined means the default event type ("message"). */
  event?: string;
  /** Accumulated `data` lines joined with LF, trailing LF removed. Empty string when no data. */
  data: string;
  /** The `retry` field value in milliseconds, if a valid one appeared in this block. */
  retry?: number;
};

export class SseTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseTimeoutError";
  }
}

export class SseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseLimitError";
  }
}

const NUL = "\u0000";
const DIGITS = /^[0-9]+$/;

/** A stateful push parser. Feed it text chunks; it returns completed events. */
export class SseParser {
  private buffer = "";
  private dataBuffer = "";
  private eventType = "";
  private idSeen: string | undefined = undefined;
  private retrySeen: number | undefined = undefined;
  private persistedId = "";
  private persistedRetry: number | undefined = undefined;

  /** The most recent `id` field value seen, persisted across events. Sent as `Last-Event-ID`. */
  get lastEventId(): string {
    return this.persistedId;
  }

  /** The most recent valid `retry` value seen, in milliseconds (undefined when none seen). */
  get retryMs(): number | undefined {
    return this.persistedRetry;
  }

  /** Feed a chunk of text. Returns every event completed by this chunk. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    for (const line of this.cutLines(false)) this.processLine(line, out);
    return out;
  }

  /** Signal end of stream. Processes any trailing complete line. Never dispatches a pending event. */
  flush(): SseEvent[] {
    const out: SseEvent[] = [];
    for (const line of this.cutLines(true)) this.processLine(line, out);
    // A pending (not blank-line-terminated) event is discarded, per the event-stream rules.
    return out;
  }

  // Cut complete lines out of the buffer. A lone trailing CR is held unless `final`,
  // because it may be the first half of a CRLF arriving in the next chunk.
  private cutLines(final: boolean): string[] {
    const lines: string[] = [];
    const buf = this.buffer;
    let start = 0;
    let i = 0;
    while (i < buf.length) {
      const ch = buf[i];
      if (ch === "\n") {
        lines.push(buf.slice(start, i));
        i += 1;
        start = i;
      } else if (ch === "\r") {
        if (i + 1 < buf.length) {
          lines.push(buf.slice(start, i));
          i += buf[i + 1] === "\n" ? 2 : 1;
          start = i;
        } else if (final) {
          lines.push(buf.slice(start, i));
          i += 1;
          start = i;
        } else {
          break; // hold the trailing CR for the next chunk
        }
      } else {
        i += 1;
      }
    }
    this.buffer = buf.slice(start);
    return lines;
  }

  private processLine(line: string, out: SseEvent[]): void {
    if (line === "") {
      this.dispatch(out);
      return;
    }
    if (line.startsWith(":")) return; // comment line, ignored
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.dataBuffer += value + "\n";
        break;
      case "id":
        if (!value.includes(NUL)) {
          this.idSeen = value;
          this.persistedId = value;
        }
        break;
      case "retry":
        if (DIGITS.test(value)) {
          const n = Number.parseInt(value, 10);
          this.retrySeen = n;
          this.persistedRetry = n;
        }
        break;
      default:
        break; // unknown field, ignored
    }
  }

  private dispatch(out: SseEvent[]): void {
    const carriedField =
      this.dataBuffer.length > 0 ||
      this.eventType !== "" ||
      this.idSeen !== undefined ||
      this.retrySeen !== undefined;
    if (carriedField) {
      let data = this.dataBuffer;
      if (data.endsWith("\n")) data = data.slice(0, -1);
      const ev: SseEvent = { data };
      if (this.idSeen !== undefined) ev.id = this.idSeen;
      if (this.eventType !== "") ev.event = this.eventType;
      if (this.retrySeen !== undefined) ev.retry = this.retrySeen;
      out.push(ev);
    }
    this.dataBuffer = "";
    this.eventType = "";
    this.idSeen = undefined;
    this.retrySeen = undefined;
  }
}

/** Parse a complete SSE string in one shot (push then flush). Convenience for fixtures. */
export function parseSse(text: string): SseEvent[] {
  const p = new SseParser();
  const out = p.push(text);
  for (const ev of p.flush()) out.push(ev);
  return out;
}

export const DEFAULT_SSE_TIMEOUT_MS = 10_000;
export const DEFAULT_SSE_MAX_BYTES = 1024 * 1024; // 1 MB ceiling on an untrusted stream

export type CollectOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  parser?: SseParser;
  signal?: AbortSignal;
  /** On timeout, return the events gathered so far instead of throwing. */
  partialOnTimeout?: boolean;
};

/**
 * Read `count` events from a fetch Response body (a byte ReadableStream). Resolves early
 * once `count` events arrive or when the stream ends (any flushed events are included).
 * Enforces a wall-clock timeout and a total-byte ceiling, then cancels the reader.
 */
export async function collectEvents(
  body: ReadableStream<Uint8Array>,
  count: number,
  opts: CollectOptions = {},
): Promise<SseEvent[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SSE_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_SSE_MAX_BYTES;
  const parser = opts.parser ?? new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const events: SseEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  let bytes = 0;
  try {
    while (events.length < count) {
      if (opts.signal?.aborted) throw new SseTimeoutError("collectEvents: aborted");
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (opts.partialOnTimeout) break;
        throw new SseTimeoutError(`collectEvents: timed out after ${timeoutMs}ms`);
      }
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await raceTimeout(reader.read(), remaining);
      } catch (e) {
        if (opts.partialOnTimeout && e instanceof SseTimeoutError) break;
        throw e;
      }
      if (result.done) {
        for (const ev of parser.flush()) events.push(ev);
        break;
      }
      bytes += result.value.byteLength;
      if (bytes > maxBytes) throw new SseLimitError(`collectEvents: exceeded ${maxBytes} bytes`);
      for (const ev of parser.push(decoder.decode(result.value, { stream: true }))) {
        events.push(ev);
        if (events.length >= count) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SseTimeoutError(`read timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Headers for a reconnect request. Empty when no id has been seen yet. */
export function lastEventIdHeader(lastEventId: string): Record<string, string> {
  return lastEventId === "" ? {} : { "Last-Event-ID": lastEventId };
}
