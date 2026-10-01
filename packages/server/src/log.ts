// Structured logger (the only logging in the server). JSON lines to stderr so stdout stays clean for
// any piped use. Redacts authorization and token-shaped fields at the sink, so S-9 holds even if a
// caller passes a header map through. No console anywhere else in the server.

import type { Logger } from "./contracts.js";

type Level = "info" | "warn" | "error";

const REDACT_KEYS = new Set(["authorization", "token", "bearer", "cookie", "set-cookie"]);

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "[redacted]" : v;
  }
  return out;
}

function emit(
  base: Record<string, unknown>,
  level: Level,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...redact(base),
    ...(fields ? redact(fields) : {}),
  });
  // One structured line per event. stderr, so it never corrupts a stdout data stream.
  process.stderr.write(line + "\n");
}

function make(base: Record<string, unknown>): Logger {
  return {
    info: (msg, fields) => emit(base, "info", msg, fields),
    warn: (msg, fields) => emit(base, "warn", msg, fields),
    error: (msg, fields) => emit(base, "error", msg, fields),
    child: (fields) => make({ ...base, ...redact(fields) }),
  };
}

/** Root logger. Pass stable context (e.g. the run mode) as the base. */
export function makeLogger(base: Record<string, unknown> = {}): Logger {
  return make(base);
}

/** A logger that drops everything. For tests and the mock adapters. */
export const nullLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
