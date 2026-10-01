// JSON-RPC 2.0 wire helpers for the conformance CLI. Pure functions only: request and
// notification builders, request-id generation and a response matcher. No I/O here.
// We speak the wire by hand (not through the MCP SDK) because the suite tests the wire.

export const JSONRPC_VERSION = "2.0";

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
};

export type JsonRpcErrorBody = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcSuccess = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId | null;
  result: unknown;
};

export type JsonRpcFailure = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId | null;
  error: JsonRpcErrorBody;
};

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

// --- id generation ----------------------------------------------------------
// Ids must be unique within a session (spec). A per-run random prefix plus a
// monotonic counter gives that without coordination between callers.

const idPrefix = randomPrefix();
let idCounter = 0;

function randomPrefix(): string {
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return s;
}

/** A fresh JSON-RPC request id, unique within this process run. */
export function nextRequestId(): string {
  idCounter += 1;
  return `${idPrefix}-${idCounter}`;
}

// --- builders ---------------------------------------------------------------

/** Build a JSON-RPC request. Omits `params` when none is given (exactOptionalPropertyTypes). */
export function buildRequest(method: string, params?: unknown, id?: JsonRpcId): JsonRpcRequest {
  const rid: JsonRpcId = id ?? nextRequestId();
  if (params === undefined) return { jsonrpc: JSONRPC_VERSION, id: rid, method };
  return { jsonrpc: JSONRPC_VERSION, id: rid, method, params };
}

/** Build a JSON-RPC notification (no id). Omits `params` when none is given. */
export function buildNotification(method: string, params?: unknown): JsonRpcNotification {
  if (params === undefined) return { jsonrpc: JSONRPC_VERSION, method };
  return { jsonrpc: JSONRPC_VERSION, method, params };
}

// --- guards and matcher -----------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isErrorBody(v: unknown): v is JsonRpcErrorBody {
  return isObject(v) && typeof v["code"] === "number" && typeof v["message"] === "string";
}

function isValidId(v: unknown): v is JsonRpcId | null {
  return typeof v === "string" || typeof v === "number" || v === null;
}

/** True when `v` is a JSON-RPC response envelope (success or failure). */
export function isJsonRpcResponse(v: unknown): v is JsonRpcResponse {
  if (!isObject(v)) return false;
  if (v["jsonrpc"] !== JSONRPC_VERSION) return false;
  if (!("id" in v) || !isValidId(v["id"])) return false;
  return "result" in v || isErrorBody(v["error"]);
}

/** True when `v` is a successful JSON-RPC response (carries `result`). */
export function isSuccess(v: JsonRpcResponse): v is JsonRpcSuccess {
  return "result" in v;
}

/** True when `v` is a JSON-RPC error response (carries `error`). */
export function isFailure(v: JsonRpcResponse): v is JsonRpcFailure {
  return "error" in v && isErrorBody((v as { error: unknown }).error);
}

/** True when `v` is a JSON-RPC notification (method, no id). */
export function isJsonRpcNotification(v: unknown): v is JsonRpcNotification {
  return (
    isObject(v) &&
    v["jsonrpc"] === JSONRPC_VERSION &&
    typeof v["method"] === "string" &&
    !("id" in v)
  );
}

/** The first response in `messages` whose id equals `id` (undefined when none match). */
export function matchResponseById(
  messages: readonly unknown[],
  id: JsonRpcId,
): JsonRpcResponse | undefined {
  for (const m of messages) {
    if (isJsonRpcResponse(m) && m.id === id) return m;
  }
  return undefined;
}

/** True when `v` is a JSON-RPC error response carrying exactly `code`. */
export function hasErrorCode(v: unknown, code: number): boolean {
  return isJsonRpcResponse(v) && isFailure(v) && v.error.code === code;
}

/** Every notification in `messages` whose method equals `method`. */
export function notificationsByMethod(
  messages: readonly unknown[],
  method: string,
): JsonRpcNotification[] {
  const out: JsonRpcNotification[] = [];
  for (const m of messages) {
    if (isJsonRpcNotification(m) && m.method === method) out.push(m);
  }
  return out;
}
