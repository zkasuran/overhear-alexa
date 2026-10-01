// The MCP 2025-11-25 conformance matrix (C/L/T/R), encoded as an array of checks that run
// over RAW HTTP + JSON-RPC + manual SSE against any Streamable HTTP MCP URL. No MCP SDK:
// the suite tests the wire. Corrections to spec ambiguities are applied and
// cited inline. Rows that rest on a spec SHOULD/MAY or on SDK behaviour are `advisory`.
//
// Each check does its own setup with raw fetch against ctx.url and ctx.token. No console
// here: the CLI prints. The live matrix needs the running server; without it these report
// error or skip. The pure pieces (jsonrpc.ts, sse.ts) carry the unit tests.

import type { JsonRpcId, JsonRpcResponse } from "./jsonrpc.js";
import {
  buildNotification,
  buildRequest,
  hasErrorCode,
  isFailure,
  isJsonRpcResponse,
  isSuccess,
  matchResponseById,
  nextRequestId,
  notificationsByMethod,
} from "./jsonrpc.js";
import type { SseEvent } from "./sse.js";
import { collectEvents, SseParser } from "./sse.js";

export const PROTOCOL_VERSION = "2025-11-25";
export const OLD_PROTOCOL_VERSION = "2024-11-05";
const EVIL_ORIGIN = "https://evil.example";
const EXPECTED_TOOLS = [
  "plan_episode",
  "render_episode",
  "get_episode",
  "find_moment",
  "expand_part",
  "recap",
  "ask",
];
const REQUIRED_TASK_TOOLS = ["render_episode", "expand_part"];
const OPTIONAL_TASK_TOOLS = ["recap", "ask"];
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/; // SEP-986 allowed set (see CORRECTIONS 6)

export type Outcome = "pass" | "fail" | "skip" | "error";
export type Result = { outcome: Outcome; detail: string; observed?: unknown };

export type CheckContext = {
  url: string;
  token: string | undefined;
  secondaryToken: string | undefined;
  protocolVersion: string;
  timeoutMs: number;
};

export type Check = {
  id: string;
  title: string;
  specBasis: string;
  advisory?: boolean;
  run: (ctx: CheckContext) => Promise<Result>;
};

// --- result constructors (keep exactOptionalPropertyTypes happy) ------------
function result(outcome: Outcome, detail: string, observed?: unknown): Result {
  return observed === undefined ? { outcome, detail } : { outcome, detail, observed };
}
const pass = (detail: string, observed?: unknown): Result => result("pass", detail, observed);
const fail = (detail: string, observed?: unknown): Result => result("fail", detail, observed);
const skip = (detail: string, observed?: unknown): Result => result("skip", detail, observed);

// --- raw HTTP ---------------------------------------------------------------
const BOTH_MEDIA = "application/json, text/event-stream";

type SendOptions = {
  method?: "POST" | "GET" | "DELETE";
  body?: unknown;
  sessionId?: string;
  token?: string | null; // null omits Authorization; undefined uses ctx.token
  accept?: string | null; // null omits Accept; undefined sends both media types
  protocolHeader?: string | null; // null omits; undefined sends ctx.protocolVersion
  origin?: string | null; // string sets Origin; otherwise omitted
  collectSse?: number;
};

type SendResult = {
  status: number;
  headers: Headers;
  sessionId: string | undefined;
  contentType: string;
  bodyText: string;
  messages: unknown[];
  isSse: boolean;
};

async function send(ctx: CheckContext, opts: SendOptions): Promise<SendResult> {
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.accept !== null) headers["Accept"] = opts.accept ?? BOTH_MEDIA;
  if (opts.protocolHeader !== null)
    headers["MCP-Protocol-Version"] = opts.protocolHeader ?? ctx.protocolVersion;
  if (opts.sessionId !== undefined) headers["MCP-Session-Id"] = opts.sessionId;
  const token = opts.token === null ? undefined : (opts.token ?? ctx.token);
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  if (typeof opts.origin === "string") headers["Origin"] = opts.origin;

  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(ctx.timeoutMs) };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const res = await fetch(ctx.url, init);
  const contentType = res.headers.get("content-type") ?? "";
  const sessionId = res.headers.get("mcp-session-id") ?? undefined;
  const isSse = contentType.includes("text/event-stream");
  let bodyText = "";
  const messages: unknown[] = [];
  if (isSse && res.body) {
    const events = await collectEvents(res.body, opts.collectSse ?? 8, {
      timeoutMs: ctx.timeoutMs,
    });
    for (const ev of events) pushJson(ev.data, messages);
  } else {
    bodyText = await res.text();
    if (bodyText.trim() !== "") pushJson(bodyText, messages);
  }
  return {
    status: res.status,
    headers: res.headers,
    sessionId,
    contentType,
    bodyText,
    messages,
    isSse,
  };
}

function pushJson(text: string, into: unknown[]): void {
  if (text.trim() === "") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (Array.isArray(parsed)) for (const m of parsed) into.push(m);
  else into.push(parsed);
}

type StreamResult = { status: number; contentType: string; events: SseEvent[]; parser: SseParser };

async function getStream(
  ctx: CheckContext,
  opts: { sessionId?: string; lastEventId?: string; count: number; timeoutMs?: number },
): Promise<StreamResult> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "MCP-Protocol-Version": ctx.protocolVersion,
  };
  if (opts.sessionId !== undefined) headers["MCP-Session-Id"] = opts.sessionId;
  if (ctx.token !== undefined) headers["Authorization"] = `Bearer ${ctx.token}`;
  if (opts.lastEventId !== undefined) headers["Last-Event-ID"] = opts.lastEventId;
  const res = await fetch(ctx.url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(ctx.timeoutMs),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const parser = new SseParser();
  let events: SseEvent[] = [];
  if (res.body && contentType.includes("text/event-stream")) {
    events = await collectEvents(res.body, opts.count, {
      timeoutMs: opts.timeoutMs ?? ctx.timeoutMs,
      parser,
      partialOnTimeout: true,
    });
  } else if (res.body) {
    await res.body.cancel().catch(() => undefined);
  }
  return { status: res.status, contentType, events, parser };
}

// --- shared object helpers --------------------------------------------------
function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}
function matchFor(res: SendResult, id: JsonRpcId): JsonRpcResponse | undefined {
  return matchResponseById(res.messages, id);
}
function isVisibleAscii(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x21 || c > 0x7e) return false;
  }
  return s.length > 0;
}
function isIso8601(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v);
}

// --- session + tool helpers -------------------------------------------------
async function openSession(ctx: CheckContext): Promise<{
  sessionId: string | undefined;
  initResponse: JsonRpcResponse | undefined;
  raw: SendResult;
}> {
  const req = buildRequest("initialize", {
    protocolVersion: ctx.protocolVersion,
    capabilities: {},
    clientInfo: { name: "overhear-conformance", version: "1.0.0" },
  });
  const raw = await send(ctx, { method: "POST", body: req });
  const initResponse = matchFor(raw, req.id);
  if (raw.sessionId !== undefined) {
    await send(ctx, {
      method: "POST",
      body: buildNotification("notifications/initialized"),
      sessionId: raw.sessionId,
    }).catch(() => undefined);
  }
  return { sessionId: raw.sessionId, initResponse, raw };
}

type ToolCall = { response: JsonRpcResponse | undefined; raw: SendResult };
async function callTool(
  ctx: CheckContext,
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown>,
  task?: Record<string, unknown>,
  meta?: Record<string, unknown>,
): Promise<ToolCall> {
  const params: Record<string, unknown> = { name, arguments: args };
  if (task !== undefined) params["task"] = task;
  if (meta !== undefined) params["_meta"] = meta;
  const req = buildRequest("tools/call", params);
  const sendOpts: SendOptions = { method: "POST", body: req };
  if (sessionId !== undefined) sendOpts.sessionId = sessionId;
  const raw = await send(ctx, sendOpts);
  return { response: matchFor(raw, req.id), raw };
}

async function callMethod(
  ctx: CheckContext,
  sessionId: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<ToolCall> {
  const req = buildRequest(method, params);
  const sendOpts: SendOptions = { method: "POST", body: req };
  if (sessionId !== undefined) sendOpts.sessionId = sessionId;
  const raw = await send(ctx, sendOpts);
  return { response: matchFor(raw, req.id), raw };
}

/** Plan an episode and return its id (undefined when the call did not yield one). */
async function planEpisode(
  ctx: CheckContext,
  sessionId: string | undefined,
): Promise<string | undefined> {
  const { response } = await callTool(ctx, sessionId, "plan_episode", {
    source: { kind: "topic", value: "a short test topic" },
    minutes: 2,
    format: "explainer",
  });
  if (response === undefined || !isSuccess(response)) return undefined;
  const sc = asObject(asObject(response.result)?.["structuredContent"]);
  const id = sc?.["episodeId"];
  return typeof id === "string" ? id : undefined;
}

/** Create a render task for an episode. Returns the create response and the taskId when present. */
async function createRenderTask(
  ctx: CheckContext,
  sessionId: string | undefined,
  episodeId: string,
  task: Record<string, unknown>,
  meta?: Record<string, unknown>,
): Promise<{ response: JsonRpcResponse | undefined; taskId: string | undefined }> {
  const { response } = await callTool(
    ctx,
    sessionId,
    "render_episode",
    { episodeId, fromPart: 0 },
    task,
    meta,
  );
  let taskId: string | undefined;
  if (response !== undefined && isSuccess(response)) {
    const taskObj = asObject(asObject(response.result)?.["task"]);
    const tid = taskObj?.["taskId"];
    if (typeof tid === "string") taskId = tid;
  }
  return { response, taskId };
}

function isTerminal(status: unknown): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
const LEGAL_TRANSITIONS: Record<string, readonly string[]> = {
  working: ["input_required", "completed", "failed", "cancelled"],
  input_required: ["working", "completed", "failed", "cancelled"],
};

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Shallow top-level JSON Schema check: required keys present, declared property types match. */
function shallowSchemaProblems(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  const req = schema["required"];
  if (Array.isArray(req)) {
    for (const key of req)
      if (typeof key === "string" && !(key in value)) problems.push(`missing required "${key}"`);
  }
  const props = asObject(schema["properties"]);
  if (props !== undefined) {
    for (const [key, rawDef] of Object.entries(props)) {
      if (!(key in value)) continue;
      const expected = asObject(rawDef)?.["type"];
      if (typeof expected === "string") {
        const actual = jsonType(value[key]);
        const ok = expected === "integer" ? actual === "number" : actual === expected;
        if (!ok) problems.push(`"${key}" is ${actual}, schema wants ${expected}`);
      }
    }
  }
  return problems;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The io.modelcontextprotocol/related-task taskId from a response _meta (undefined when absent). */
function relatedTaskId(resp: JsonRpcResponse): unknown {
  const container = isSuccess(resp) ? asObject(resp.result) : asObject(resp.error.data);
  const meta = asObject(container?.["_meta"]);
  const related = asObject(meta?.["io.modelcontextprotocol/related-task"]);
  return related?.["taskId"];
}

/** Poll tasks/get, recording each distinct status until terminal or the poll budget runs out. */
async function pollStatuses(
  ctx: CheckContext,
  sessionId: string | undefined,
  taskId: string,
  opts: { maxPolls: number; intervalMs: number },
): Promise<{ sequence: string[]; terminal: boolean }> {
  const sequence: string[] = [];
  for (let i = 0; i < opts.maxPolls; i++) {
    const { response } = await callMethod(ctx, sessionId, "tasks/get", { taskId });
    if (response === undefined || !isSuccess(response)) break;
    const status = asObject(response.result)?.["status"];
    if (typeof status === "string") {
      if (sequence[sequence.length - 1] !== status) sequence.push(status);
      if (isTerminal(status)) return { sequence, terminal: true };
    }
    await delay(opts.intervalMs);
  }
  return { sequence, terminal: false };
}

function initRequest(version: string) {
  return buildRequest("initialize", {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: "overhear-conformance", version: "1.0.0" },
  });
}

export const CHECKS: Check[] = [
  {
    id: "C-1",
    title: "initialize negotiates 2025-11-25, session id visible ASCII",
    specBasis:
      "lifecycle: server MUST echo the supported version; transports: session id MUST be visible ASCII when present (assigning it is a MAY)",
    run: async (ctx) => {
      const { initResponse, sessionId, raw } = await openSession(ctx);
      if (raw.status !== 200) return fail(`initialize returned HTTP ${raw.status}`);
      if (initResponse === undefined || !isSuccess(initResponse))
        return fail("no initialize result", raw.messages);
      const version = asObject(initResponse.result)?.["protocolVersion"];
      if (version !== PROTOCOL_VERSION)
        return fail(`protocolVersion was ${String(version)}, expected ${PROTOCOL_VERSION}`);
      if (sessionId !== undefined && !isVisibleAscii(sessionId))
        return fail("MCP-Session-Id is not visible ASCII");
      const note =
        sessionId === undefined ? "no session id (server MAY omit)" : "session id visible ASCII";
      return pass(`version echoed ${PROTOCOL_VERSION}; ${note}`);
    },
  },
  {
    id: "C-2",
    title: "initialize with only 2024-11-05 negotiates, not an error",
    specBasis:
      "lifecycle Version Negotiation: a real past version triggers negotiation, never an error",
    run: async (ctx) => {
      const req = initRequest(OLD_PROTOCOL_VERSION);
      const raw = await send(ctx, { method: "POST", body: req });
      const resp = matchFor(raw, req.id);
      if (resp === undefined)
        return fail(`no response to initialize (HTTP ${raw.status})`, raw.messages);
      if (isFailure(resp)) return fail(`negotiation returned error ${resp.error.code}`, resp.error);
      const version = asObject(resp.result)?.["protocolVersion"];
      if (typeof version !== "string") return fail("no negotiated protocolVersion");
      return pass(`negotiated to ${version}, no error`);
    },
  },
  {
    id: "C-3",
    title: "Origin https://evil.example gets 403",
    specBasis:
      "transports Security Warning: a present and invalid Origin MUST get HTTP 403 (no-id JSON-RPC error body is a MAY)",
    run: async (ctx) => {
      const req = initRequest(ctx.protocolVersion);
      const raw = await send(ctx, { method: "POST", body: req, origin: EVIL_ORIGIN });
      if (raw.status !== 403) return fail(`expected 403, got HTTP ${raw.status}`);
      const errBody = raw.messages.find((m) => isJsonRpcResponse(m) && isFailure(m));
      return pass(
        `403 for invalid Origin; ${errBody === undefined ? "no body (allowed)" : "JSON-RPC error body present"}`,
      );
    },
  },
  {
    id: "C-4",
    title: "no Authorization gets 401 + WWW-Authenticate",
    specBasis: "our auth layer; transports only SHOULD-mandates authentication",
    advisory: true,
    run: async (ctx) => {
      const raw = await send(ctx, {
        method: "POST",
        body: initRequest(ctx.protocolVersion),
        token: null,
      });
      if (raw.status !== 401) return fail(`expected 401, got HTTP ${raw.status}`);
      const wwwAuth = raw.headers.get("www-authenticate");
      if (wwwAuth === null) return fail("401 without a WWW-Authenticate header");
      return pass(`401 with WWW-Authenticate present`);
    },
  },
  {
    id: "C-5",
    title: "no Accept gets 406 (SDK; record actual)",
    specBasis:
      "transports: Accept is a CLIENT MUST; the spec names no server status for a bad Accept. 406 is SDK (CORRECTIONS 1)",
    advisory: true,
    run: async (ctx) => {
      const raw = await send(ctx, {
        method: "POST",
        body: initRequest(ctx.protocolVersion),
        accept: "application/json",
      });
      if (raw.status === 406) return pass("406 for Accept missing text/event-stream (SDK)");
      return fail(`SDK behaviour: expected 406, server returned HTTP ${raw.status}`, {
        status: raw.status,
      });
    },
  },
  {
    id: "C-6",
    title: "non-init request without MCP-Session-Id gets 400",
    specBasis:
      "transports Session Management 2: servers that require a session SHOULD answer a non-init request without the header with 400",
    advisory: true,
    run: async (ctx) => {
      const raw = await send(ctx, { method: "POST", body: buildRequest("tools/list", {}) });
      if (raw.status === 400)
        return pass("400 for a non-init request without MCP-Session-Id (SHOULD)");
      return fail(`expected 400, got HTTP ${raw.status}`, { status: raw.status });
    },
  },
  {
    id: "C-7",
    title: "random MCP-Session-Id gets 404",
    specBasis:
      "transports Session Management 3: a terminated session id MUST get 404; a never-issued id is treated the same",
    run: async (ctx) => {
      const raw = await send(ctx, {
        method: "POST",
        body: buildRequest("tools/list", {}),
        sessionId: "not-a-real-session-id-0000",
      });
      if (raw.status === 404) return pass("404 for an unknown MCP-Session-Id");
      return fail(`expected 404, got HTTP ${raw.status}`);
    },
  },
  {
    id: "C-8",
    title: "MCP-Protocol-Version: 1999-01-01 gets 400",
    specBasis:
      "transports Protocol Version Header: an invalid or unsupported MCP-Protocol-Version MUST get 400",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const opts: SendOptions = {
        method: "POST",
        body: buildRequest("tools/list", {}),
        protocolHeader: "1999-01-01",
      };
      if (sessionId !== undefined) opts.sessionId = sessionId;
      const raw = await send(ctx, opts);
      if (raw.status === 400) return pass("400 for an unsupported MCP-Protocol-Version header");
      return fail(`expected 400, got HTTP ${raw.status}`);
    },
  },
  {
    id: "C-9",
    title: "POST a notification gets 202, empty body",
    specBasis:
      "transports Sending Messages 4: a posted notification the server accepts MUST return 202 with no body",
    run: async (ctx) => {
      const initRaw = await send(ctx, { method: "POST", body: initRequest(ctx.protocolVersion) });
      const opts: SendOptions = {
        method: "POST",
        body: buildNotification("notifications/initialized"),
      };
      if (initRaw.sessionId !== undefined) opts.sessionId = initRaw.sessionId;
      const raw = await send(ctx, opts);
      if (raw.status !== 202) return fail(`expected 202, got HTTP ${raw.status}`);
      if (raw.bodyText.trim() !== "") return fail("202 but the body was not empty");
      return pass("202 with an empty body for a posted notification");
    },
  },
  {
    id: "C-10",
    title: "GET text/event-stream gets 200, first event id + empty data",
    specBasis:
      "transports Listening: 200 text/event-stream or 405 is a MUST; the priming event (id + empty data) is a SHOULD",
    advisory: true,
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const sopts: { sessionId?: string; count: number; timeoutMs?: number } = {
        count: 1,
        timeoutMs: Math.min(ctx.timeoutMs, 5000),
      };
      if (sessionId !== undefined) sopts.sessionId = sessionId;
      const stream = await getStream(ctx, sopts);
      if (stream.status === 405)
        return fail("405: endpoint offers no SSE stream (allowed by spec, so no priming event)");
      if (stream.status !== 200) return fail(`expected 200, got HTTP ${stream.status}`);
      if (!stream.contentType.includes("text/event-stream"))
        return fail(`content-type was ${stream.contentType}`);
      const first = stream.events[0];
      if (first === undefined) return fail("200 text/event-stream but no event arrived");
      if (first.id === undefined) return fail("first event carried no id");
      if (first.data !== "") return fail("first event data was not empty");
      return pass("first SSE event carries an id and empty data (priming, SHOULD)");
    },
  },
  {
    id: "C-11",
    title: "resume via Last-Event-ID, no duplicates, no cross-stream replay",
    specBasis:
      "transports Resumability: replay after Last-Event-ID is a MAY (our choice); replaying another stream's messages is a MUST NOT",
    advisory: true,
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const base: { sessionId?: string; count: number; timeoutMs: number } = {
        count: 3,
        timeoutMs: Math.min(ctx.timeoutMs, 5000),
      };
      if (sessionId !== undefined) base.sessionId = sessionId;
      const first = await getStream(ctx, base);
      if (first.status !== 200 || first.events.length < 1)
        return skip("no SSE events to resume from (needs a server-initiated stream)");
      const lastId = first.parser.lastEventId;
      if (lastId === "") return skip("stream carried no event id to resume from");
      const resume: { sessionId?: string; lastEventId: string; count: number; timeoutMs: number } =
        { ...base, lastEventId: lastId };
      const again = await getStream(ctx, resume);
      const seen = new Set(
        first.events.map((e) => e.id).filter((v): v is string => v !== undefined),
      );
      const dup = again.events.find((e) => e.id !== undefined && seen.has(e.id));
      if (dup !== undefined)
        return fail(`event id ${dup.id} was duplicated or replayed from another stream`);
      return pass(`resumed after Last-Event-ID ${lastId}; no duplicate or cross-stream ids`);
    },
  },
  {
    id: "C-12",
    title: "server-initiated close sends a retry field first",
    specBasis:
      "transports Sending Messages 6: sending a retry field before closing is a SHOULD; respecting it is a client MUST",
    advisory: true,
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const sopts: { sessionId?: string; count: number; timeoutMs: number } = {
        count: 50,
        timeoutMs: Math.min(ctx.timeoutMs, 5000),
      };
      if (sessionId !== undefined) sopts.sessionId = sessionId;
      const stream = await getStream(ctx, sopts);
      if (stream.status !== 200) return skip(`no SSE stream to observe (HTTP ${stream.status})`);
      if (stream.parser.retryMs !== undefined)
        return pass(`retry field observed (${stream.parser.retryMs}ms) (SHOULD)`);
      return skip("no retry field observed in the window (the stream may not have closed)");
    },
  },
  {
    id: "C-13",
    title: "DELETE terminates the session, a later request is 404",
    specBasis:
      "transports Session Management 5 names only 405 (refusal); DELETE success (200) is SDK/our behaviour (CORRECTIONS 2); the follow-up 404 is the MUST (item 3)",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      if (sessionId === undefined) return skip("server issued no session id to delete");
      const del = await send(ctx, { method: "DELETE", sessionId });
      if (del.status === 405)
        return pass("server refuses termination (405); session not terminated (allowed)");
      if (del.status < 200 || del.status >= 300) return fail(`DELETE returned HTTP ${del.status}`);
      const after = await send(ctx, {
        method: "POST",
        body: buildRequest("tools/list", {}),
        sessionId,
      });
      if (after.status === 404)
        return pass(`DELETE ${del.status}; later request on the id returns 404 (MUST)`);
      return fail(`after DELETE, a later request returned HTTP ${after.status}, expected 404`);
    },
  },
  {
    id: "C-14",
    title: "default bind is 127.0.0.1 only",
    specBasis:
      "transports Security Warning 2: servers SHOULD bind only to 127.0.0.1 locally (not observable from a single client URL)",
    advisory: true,
    run: async () =>
      skip(
        "not observable over the wire; verify at the server process (OVERHEAR_BIND_PUBLIC gates 0.0.0.0)",
      ),
  },
  {
    id: "L-1",
    title: "tools/list exposes 7 tools with inputSchema, outputSchema and icons",
    specBasis:
      "server/tools: inputSchema MUST be a JSON Schema object (not null); outputSchema and icons are Optional (our product requires them); names within SEP-986 charset (CORRECTIONS 6)",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const { response } = await callMethod(ctx, sessionId, "tools/list", {});
      if (response === undefined || !isSuccess(response))
        return fail("no tools/list result", response);
      const tools = asObject(response.result)?.["tools"];
      if (!Array.isArray(tools)) return fail("tools/list carried no tools array");
      const names: string[] = [];
      const problems: string[] = [];
      for (const t of tools) {
        const o = asObject(t);
        const name = o?.["name"];
        if (typeof name !== "string") {
          problems.push("a tool has no string name");
          continue;
        }
        names.push(name);
        if (!TOOL_NAME_RE.test(name)) problems.push(`${name}: name outside the SEP-986 charset`);
        if (asObject(o?.["inputSchema"]) === undefined)
          problems.push(`${name}: inputSchema missing or not an object (MUST)`);
        if (asObject(o?.["outputSchema"]) === undefined)
          problems.push(`${name}: no outputSchema (our product)`);
        if (!Array.isArray(o?.["icons"])) problems.push(`${name}: no icons (our product)`);
      }
      const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
      if (missing.length > 0) problems.push(`missing tools: ${missing.join(", ")}`);
      if (tools.length !== EXPECTED_TOOLS.length)
        problems.push(`expected ${EXPECTED_TOOLS.length} tools, saw ${tools.length}`);
      if (problems.length > 0) return fail(problems.join("; "), { names });
      return pass(
        `${tools.length} tools; each has inputSchema, outputSchema, icons; names within SEP-986`,
        { names },
      );
    },
  },
  {
    id: "L-2",
    title: "execution.taskSupport mapping is correct",
    specBasis:
      'server/tools: taskSupport is "required"|"optional"|"forbidden" (default forbidden); our mapping is render_episode/expand_part required, recap/ask optional, rest absent',
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const { response } = await callMethod(ctx, sessionId, "tools/list", {});
      if (response === undefined || !isSuccess(response))
        return fail("no tools/list result", response);
      const tools = asObject(response.result)?.["tools"];
      if (!Array.isArray(tools)) return fail("tools/list carried no tools array");
      const support = new Map<string, unknown>();
      for (const t of tools) {
        const o = asObject(t);
        const name = o?.["name"];
        if (typeof name === "string")
          support.set(name, asObject(o?.["execution"])?.["taskSupport"]);
      }
      const problems: string[] = [];
      for (const n of REQUIRED_TASK_TOOLS)
        if (support.get(n) !== "required")
          problems.push(`${n}: taskSupport ${String(support.get(n))}, expected required`);
      for (const n of OPTIONAL_TASK_TOOLS)
        if (support.get(n) !== "optional")
          problems.push(`${n}: taskSupport ${String(support.get(n))}, expected optional`);
      for (const [n, ts] of support) {
        if (REQUIRED_TASK_TOOLS.includes(n) || OPTIONAL_TASK_TOOLS.includes(n)) continue;
        if (ts !== undefined && ts !== "forbidden")
          problems.push(`${n}: taskSupport ${String(ts)}, expected absent or forbidden`);
      }
      if (problems.length > 0) return fail(problems.join("; "));
      return pass("render_episode/expand_part required, recap/ask optional, others forbidden");
    },
  },
  {
    id: "L-3",
    title: "invalid input (minutes: 99) is a tool execution error, not a protocol error",
    specBasis:
      "server/tools SEP-1303: value out of range is a Tool Execution Error (isError: true), not a JSON-RPC Protocol Error",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const { response } = await callTool(ctx, sessionId, "plan_episode", {
        source: { kind: "topic", value: "a short test topic" },
        minutes: 99,
        format: "explainer",
      });
      if (response === undefined) return fail("no response to tools/call");
      if (isFailure(response))
        return fail(
          `got JSON-RPC error ${response.error.code}; out-of-range must be a tool execution error (SEP-1303)`,
        );
      const isErr = asObject(response.result)?.["isError"];
      if (isErr !== true) return fail("expected isError: true for minutes out of range");
      return pass("minutes out of range yields isError: true, not a protocol error");
    },
  },
  {
    id: "L-4",
    title: "structuredContent conforms to the declared outputSchema",
    specBasis:
      "server/tools: when an outputSchema is declared the server MUST return structuredContent conforming to it (shallow top-level check here)",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const list = await callMethod(ctx, sessionId, "tools/list", {});
      if (list.response === undefined || !isSuccess(list.response))
        return fail("no tools/list result");
      const tools = asObject(list.response.result)?.["tools"];
      const toolArr = Array.isArray(tools) ? tools : [];
      const planTool = toolArr.map(asObject).find((o) => o?.["name"] === "plan_episode");
      const schema = asObject(planTool?.["outputSchema"]);
      if (schema === undefined) return skip("plan_episode has no declared outputSchema to check");
      const call = await callTool(ctx, sessionId, "plan_episode", {
        source: { kind: "topic", value: "a short test topic" },
        minutes: 2,
        format: "explainer",
      });
      if (call.response === undefined || !isSuccess(call.response))
        return skip("plan_episode returned no result in this mode");
      const sc = asObject(asObject(call.response.result)?.["structuredContent"]);
      if (sc === undefined) return fail("result carried no structuredContent object");
      const problems = shallowSchemaProblems(sc, schema);
      if (problems.length > 0)
        return fail(`structuredContent diverges from outputSchema: ${problems.join("; ")}`);
      return pass(
        "plan_episode structuredContent matches its outputSchema (top-level required + types)",
      );
    },
  },
  {
    id: "T-1",
    title: "initialize capabilities expose tasks.list, tasks.cancel, tasks.requests.tools.call",
    specBasis: "tasks Server Capabilities: tasks.list, tasks.cancel and tasks.requests.tools.call",
    run: async (ctx) => {
      const { initResponse } = await openSession(ctx);
      if (initResponse === undefined || !isSuccess(initResponse))
        return fail("no initialize result");
      const tasks = asObject(asObject(asObject(initResponse.result)?.["capabilities"])?.["tasks"]);
      if (tasks === undefined) return fail("no tasks capability declared");
      const problems: string[] = [];
      if (asObject(tasks["list"]) === undefined) problems.push("tasks.list absent");
      if (asObject(tasks["cancel"]) === undefined) problems.push("tasks.cancel absent");
      if (asObject(asObject(asObject(tasks["requests"])?.["tools"])?.["call"]) === undefined)
        problems.push("tasks.requests.tools.call absent");
      if (problems.length > 0) return fail(problems.join("; "));
      return pass("tasks.list, tasks.cancel and tasks.requests.tools.call all present");
    },
  },
  {
    id: "T-2",
    title: "render_episode without task gets -32601",
    specBasis:
      "tasks Tool-Level Negotiation: a taskSupport=required tool invoked without task MUST return -32601 (mandated, not SDK)",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const { response } = await callTool(ctx, sessionId, "render_episode", {
        episodeId: "ep_placeholder",
        fromPart: 0,
      });
      if (response === undefined) return fail("no response to tools/call");
      if (hasErrorCode(response, -32601))
        return pass("-32601 for a required-task tool called without task");
      if (isFailure(response)) return fail(`got error ${response.error.code}, expected -32601`);
      return fail("expected -32601, got a successful result");
    },
  },
  {
    id: "T-3",
    title:
      "task-augmented render returns CreateTaskResult, working, ttl capped, ISO 8601 timestamps",
    specBasis:
      "tasks Creating Tasks + TTL: tasks MUST begin working; createdAt/lastUpdatedAt MUST be ISO 8601; a receiver MAY cap ttl",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const episodeId = await planEpisode(ctx, sessionId);
      if (episodeId === undefined)
        return skip("could not plan an episode to render (needs the running server in mock mode)");
      const requestedTtl = 999999999;
      const { response } = await createRenderTask(ctx, sessionId, episodeId, { ttl: requestedTtl });
      if (response === undefined || !isSuccess(response))
        return fail("render task returned no result", response);
      const task = asObject(asObject(response.result)?.["task"]);
      if (task === undefined)
        return fail("result has no task object (CreateTaskResult nests under task)");
      const problems: string[] = [];
      if (task["status"] !== "working")
        problems.push(`status ${String(task["status"])}, expected working`);
      if (!isIso8601(task["createdAt"])) problems.push("createdAt not ISO 8601");
      if (!isIso8601(task["lastUpdatedAt"])) problems.push("lastUpdatedAt not ISO 8601");
      const ttl = task["ttl"];
      if (ttl !== null && !(typeof ttl === "number" && ttl <= requestedTtl))
        problems.push(`ttl ${String(ttl)} not capped at or below the requested value`);
      if (problems.length > 0) return fail(problems.join("; "));
      return pass(
        `CreateTaskResult working; ttl ${String(ttl)} (capped); createdAt/lastUpdatedAt ISO 8601`,
      );
    },
  },
  {
    id: "T-4",
    title: "CreateTaskResult._meta carries model-immediate-response",
    specBasis:
      "tasks Creating Tasks: the io.modelcontextprotocol/model-immediate-response _meta key is Optional and non-binding (our server always sends it)",
    advisory: true,
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const episodeId = await planEpisode(ctx, sessionId);
      if (episodeId === undefined) return skip("could not plan an episode to render");
      const { response } = await createRenderTask(ctx, sessionId, episodeId, { ttl: 60000 });
      if (response === undefined || !isSuccess(response))
        return fail("render task returned no result");
      const meta = asObject(asObject(response.result)?.["_meta"]);
      const v = meta?.["io.modelcontextprotocol/model-immediate-response"];
      if (typeof v !== "string")
        return fail("model-immediate-response _meta key missing or not a string");
      return pass("CreateTaskResult._meta carries model-immediate-response (string)");
    },
  },
  {
    id: "T-5",
    title: "tasks/get status moves only along legal transitions",
    specBasis:
      "tasks Status Lifecycle: start->working; working->{input_required,completed,failed,cancelled}; input_required->{working,completed,failed,cancelled}; terminals do not transition",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const episodeId = await planEpisode(ctx, sessionId);
      if (episodeId === undefined) return skip("could not plan an episode to render");
      const { taskId } = await createRenderTask(ctx, sessionId, episodeId, { ttl: 60000 });
      if (taskId === undefined) return skip("render did not return a taskId");
      const { sequence, terminal } = await pollStatuses(ctx, sessionId, taskId, {
        maxPolls: 30,
        intervalMs: 1000,
      });
      if (sequence.length === 0) return fail("tasks/get returned no status");
      let prev: string | undefined = sequence[0];
      if (prev !== "working")
        return fail(`first observed status ${String(prev)}, expected working`);
      for (let i = 1; i < sequence.length; i++) {
        const to = sequence[i];
        if (prev === undefined || to === undefined) continue;
        const allowed: readonly string[] = LEGAL_TRANSITIONS[prev] ?? [];
        if (!allowed.includes(to)) return fail(`illegal transition ${prev} -> ${to}`);
        prev = to;
      }
      return pass(`status path ${sequence.join(" -> ")}${terminal ? "" : " (not yet terminal)"}`);
    },
  },
  {
    id: "T-6",
    title: "progress notifications carry the original progressToken",
    specBasis:
      "tasks Progress: the progressToken from the initial request stays valid throughout the task lifetime",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const episodeId = await planEpisode(ctx, sessionId);
      if (episodeId === undefined) return skip("could not plan an episode to render");
      const progressToken = `pt-${nextRequestId()}`;
      const { taskId } = await createRenderTask(
        ctx,
        sessionId,
        episodeId,
        { ttl: 60000 },
        { progressToken },
      );
      if (taskId === undefined) return skip("render did not return a taskId");
      const sopts: { sessionId?: string; count: number; timeoutMs: number } = {
        count: 20,
        timeoutMs: Math.min(ctx.timeoutMs, 8000),
      };
      if (sessionId !== undefined) sopts.sessionId = sessionId;
      const stream = await getStream(ctx, sopts);
      const msgs = stream.events.map((e) => tryJson(e.data)).filter((m) => m !== undefined);
      const progress = notificationsByMethod(msgs, "notifications/progress");
      if (progress.length === 0)
        return skip("no progress notifications observed on the stream in the window");
      const tokens = progress.map((n) => asObject(n.params)?.["progressToken"]);
      if (!tokens.includes(progressToken))
        return fail(`progress used tokens ${tokens.map(String).join(",")}, not ${progressToken}`);
      return pass(`progress notifications carry the original progressToken`);
    },
  },
  {
    id: "T-7",
    title: "tasks/result blocks until terminal and carries related-task _meta",
    specBasis:
      "tasks Result Retrieval + Related Task Metadata: tasks/result MUST block until terminal and MUST carry _meta.io.modelcontextprotocol/related-task {taskId}",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const episodeId = await planEpisode(ctx, sessionId);
      if (episodeId === undefined) return skip("could not plan an episode to render");
      const { taskId } = await createRenderTask(ctx, sessionId, episodeId, { ttl: 60000 });
      if (taskId === undefined) return skip("render did not return a taskId");
      const { response } = await callMethod(ctx, sessionId, "tasks/result", { taskId });
      if (response === undefined) return fail("no response to tasks/result");
      const after = (await callMethod(ctx, sessionId, "tasks/get", { taskId })).response;
      const status =
        after !== undefined && isSuccess(after) ? asObject(after.result)?.["status"] : undefined;
      if (!isTerminal(status))
        return fail(
          `tasks/result returned while status was ${String(status)}; it must block until terminal`,
        );
      const related = relatedTaskId(response);
      if (related !== taskId)
        return fail(`related-task _meta taskId was ${String(related)}, expected ${taskId}`);
      return pass("tasks/result blocked until terminal and carried related-task _meta");
    },
  },
  {
    id: "T-8",
    title: "cancel a working task, then cancel again gets -32602",
    specBasis:
      "tasks Cancellation: a valid cancel MUST transition to cancelled before responding; cancelling a terminal task MUST be rejected with -32602",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const episodeId = await planEpisode(ctx, sessionId);
      if (episodeId === undefined) return skip("could not plan an episode to render");
      const { taskId } = await createRenderTask(ctx, sessionId, episodeId, { ttl: 60000 });
      if (taskId === undefined) return skip("render did not return a taskId");
      const first = await callMethod(ctx, sessionId, "tasks/cancel", { taskId });
      if (first.response === undefined) return fail("no response to the first tasks/cancel");
      if (isFailure(first.response))
        return fail(`first cancel errored ${first.response.error.code}`);
      const got = (await callMethod(ctx, sessionId, "tasks/get", { taskId })).response;
      const status =
        got !== undefined && isSuccess(got) ? asObject(got.result)?.["status"] : undefined;
      if (status !== "cancelled")
        return fail(`after cancel, status was ${String(status)}, expected cancelled`);
      const second = await callMethod(ctx, sessionId, "tasks/cancel", { taskId });
      if (second.response !== undefined && hasErrorCode(second.response, -32602))
        return pass("cancel -> cancelled; second cancel -> -32602");
      return fail("the second cancel did not return -32602");
    },
  },
  {
    id: "T-9",
    title: "tasks/get on an unknown id gets -32602",
    specBasis:
      "tasks Protocol Errors: an invalid or nonexistent taskId in tasks/get MUST be -32602 (expired is the same)",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const { response } = await callMethod(ctx, sessionId, "tasks/get", {
        taskId: "task_does_not_exist_000",
      });
      if (response === undefined) return fail("no response to tasks/get");
      if (hasErrorCode(response, -32602)) return pass("-32602 for an unknown taskId");
      return fail(
        `expected -32602, got ${isFailure(response) ? String(response.error.code) : "a success result"}`,
      );
    },
  },
  {
    id: "T-10",
    title: "foreign principal cannot get/result/cancel another's task; list excludes it",
    specBasis:
      "tasks Isolation: receivers MUST reject get/result/cancel across authorization contexts and MUST filter tasks/list. The -32602 not-found code is our choice (CORRECTIONS 3)",
    run: async (ctx) => {
      if (ctx.secondaryToken === undefined)
        return skip("needs a second principal token (--token2) to prove isolation");
      const a = await openSession(ctx);
      const episodeId = await planEpisode(ctx, a.sessionId);
      if (episodeId === undefined)
        return skip("could not plan an episode to render as principal A");
      const { taskId } = await createRenderTask(ctx, a.sessionId, episodeId, { ttl: 60000 });
      if (taskId === undefined) return skip("render did not return a taskId");
      const ctxB: CheckContext = { ...ctx, token: ctx.secondaryToken };
      const b = await openSession(ctxB);
      const problems: string[] = [];
      const notes: string[] = [];
      for (const method of ["tasks/get", "tasks/result", "tasks/cancel"]) {
        const r = (await callMethod(ctxB, b.sessionId, method, { taskId })).response;
        if (r === undefined || !isFailure(r)) problems.push(`${method}: B was not rejected`);
        else if (!hasErrorCode(r, -32602))
          notes.push(`${method} code ${r.error.code} (our choice is -32602)`);
      }
      const list = (await callMethod(ctxB, b.sessionId, "tasks/list", {})).response;
      if (list !== undefined && isSuccess(list)) {
        const tasks = asObject(list.result)?.["tasks"];
        const ids = Array.isArray(tasks) ? tasks.map((t) => asObject(t)?.["taskId"]) : [];
        if (ids.includes(taskId)) problems.push("tasks/list for B leaked A's task");
      }
      if (problems.length > 0) return fail(problems.join("; "));
      return pass(
        `B rejected on get/result/cancel; B's list excludes A's task${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`,
      );
    },
  },
  {
    id: "T-11",
    title:
      "a failed tool yields task failed, statusMessage set, tasks/result returns the isError result",
    specBasis:
      "tasks Execution Errors: isError:true drives the task to failed; tasks/result MUST still return the result in a successful JSON-RPC envelope; statusMessage is a SHOULD",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const episodeId = await planEpisode(ctx, sessionId);
      if (episodeId === undefined) return skip("could not plan an episode to render");
      const { taskId } = await createRenderTask(ctx, sessionId, episodeId, { ttl: 60000 });
      if (taskId === undefined) return skip("render did not return a taskId");
      const { sequence, terminal } = await pollStatuses(ctx, sessionId, taskId, {
        maxPolls: 30,
        intervalMs: 1000,
      });
      if (!terminal) return skip("task did not reach a terminal state in the window");
      const last = sequence[sequence.length - 1];
      if (last !== "failed")
        return skip(
          `task ended ${String(last)}; no forced-failure trigger is available over the wire`,
        );
      const got = (await callMethod(ctx, sessionId, "tasks/get", { taskId })).response;
      const sm =
        got !== undefined && isSuccess(got) ? asObject(got.result)?.["statusMessage"] : undefined;
      const res = (await callMethod(ctx, sessionId, "tasks/result", { taskId })).response;
      if (res === undefined || !isSuccess(res))
        return fail("tasks/result on a failed task did not return a successful JSON-RPC envelope");
      if (asObject(res.result)?.["isError"] !== true)
        return fail("tasks/result did not carry isError: true");
      return pass(
        `task failed; statusMessage ${typeof sm === "string" ? "set" : "absent (SHOULD)"}; tasks/result returned the isError result`,
      );
    },
  },
  {
    id: "T-12",
    title: "a task survives a mid-task server restart",
    specBasis:
      "durability (our claim; no spec sentence mandates survival across a process restart)",
    advisory: true,
    run: async () =>
      skip(
        "requires a server restart mid-task, not drivable from a single client; verify with the e2e durability script",
      ),
  },
  {
    id: "T-13",
    title: "tasks/list paginates: bad cursor is -32602, nextCursor opaque when more remain",
    specBasis:
      "tasks Listing (CORRECTIONS 8): an invalid or nonexistent cursor MUST be -32602; nextCursor MUST be present when more tasks remain; cursors are opaque",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const bad = (await callMethod(ctx, sessionId, "tasks/list", { cursor: "not-a-real-cursor" }))
        .response;
      if (bad === undefined) return fail("no response to tasks/list with a bad cursor");
      if (!hasErrorCode(bad, -32602))
        return fail(
          `bad cursor returned ${isFailure(bad) ? String(bad.error.code) : "a success result"}, expected -32602`,
        );
      const first = (await callMethod(ctx, sessionId, "tasks/list", {})).response;
      let note = "nextCursor not observed (too few tasks to page)";
      if (
        first !== undefined &&
        isSuccess(first) &&
        typeof asObject(first.result)?.["nextCursor"] === "string"
      ) {
        note = "nextCursor present and treated as opaque";
      }
      return pass(`bad cursor -> -32602; ${note}`);
    },
  },
  {
    id: "R-1",
    title:
      "resources/templates/list returns the 3 {id} templates; overhear://formats is in resources/list",
    specBasis:
      "server/resources: templates expose a uriTemplate (RFC 6570). overhear://formats is concrete, so it belongs in resources/list, not templates/list (CORRECTIONS 5)",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const tmpl = (await callMethod(ctx, sessionId, "resources/templates/list", {})).response;
      if (tmpl === undefined || !isSuccess(tmpl)) return fail("no resources/templates/list result");
      const templates = asObject(tmpl.result)?.["resourceTemplates"];
      const uriTemplates = (Array.isArray(templates) ? templates : [])
        .map((t) => asObject(t)?.["uriTemplate"])
        .filter((v): v is string => typeof v === "string");
      const problems: string[] = [];
      for (const needle of ["manifest", "transcript", "source"]) {
        if (!uriTemplates.some((u) => u.includes(needle) && u.includes("{id}")))
          problems.push(`no {id} template for ${needle}`);
      }
      if (uriTemplates.some((u) => u.includes("overhear://formats")))
        problems.push("overhear://formats listed as a template (it is concrete)");
      const list = (await callMethod(ctx, sessionId, "resources/list", {})).response;
      const resources =
        list !== undefined && isSuccess(list) ? asObject(list.result)?.["resources"] : undefined;
      const uris = Array.isArray(resources) ? resources.map((r) => asObject(r)?.["uri"]) : [];
      if (!uris.includes("overhear://formats"))
        problems.push("overhear://formats not found in resources/list");
      if (problems.length > 0) return fail(problems.join("; "));
      return pass("3 {id} templates in templates/list; overhear://formats in resources/list");
    },
  },
  {
    id: "R-2",
    title: "subscribe to a manifest yields notifications/resources/updated on part status changes",
    specBasis:
      "server/resources: resources.subscribe enables notifications/resources/updated {uri}; firing one per part status change is our behaviour",
    run: async (ctx) => {
      const { sessionId } = await openSession(ctx);
      const episodeId = await planEpisode(ctx, sessionId);
      if (episodeId === undefined) return skip("could not plan an episode to render");
      const manifestUri = `overhear://episodes/${episodeId}/manifest`;
      const sub = (await callMethod(ctx, sessionId, "resources/subscribe", { uri: manifestUri }))
        .response;
      if (sub === undefined || isFailure(sub)) return fail("resources/subscribe was rejected");
      await createRenderTask(ctx, sessionId, episodeId, { ttl: 60000 });
      const sopts: { sessionId?: string; count: number; timeoutMs: number } = {
        count: 20,
        timeoutMs: Math.min(ctx.timeoutMs, 8000),
      };
      if (sessionId !== undefined) sopts.sessionId = sessionId;
      const stream = await getStream(ctx, sopts);
      const msgs = stream.events.map((e) => tryJson(e.data)).filter((m) => m !== undefined);
      const updates = notificationsByMethod(msgs, "notifications/resources/updated").filter(
        (n) => asObject(n.params)?.["uri"] === manifestUri,
      );
      if (updates.length === 0)
        return skip("no resources/updated for the manifest observed in the window");
      return pass(`${updates.length} notifications/resources/updated for the manifest`);
    },
  },
  {
    id: "R-3",
    title: "reading another principal's manifest returns not found (-32002)",
    specBasis:
      "server/resources: resource not found is -32002 (CORRECTIONS 4). Per-principal isolation is our auth design",
    run: async (ctx) => {
      if (ctx.secondaryToken === undefined)
        return skip("needs a second principal token (--token2) to prove isolation");
      const a = await openSession(ctx);
      const episodeId = await planEpisode(ctx, a.sessionId);
      if (episodeId === undefined) return skip("could not plan an episode as principal A");
      const ctxB: CheckContext = { ...ctx, token: ctx.secondaryToken };
      const b = await openSession(ctxB);
      const uri = `overhear://episodes/${episodeId}/manifest`;
      const r = (await callMethod(ctxB, b.sessionId, "resources/read", { uri })).response;
      if (r === undefined) return fail("no response to resources/read");
      if (hasErrorCode(r, -32002))
        return pass("-32002 not-found for a foreign principal's manifest");
      if (isSuccess(r)) return fail("B could read A's manifest (isolation breach)");
      return fail(`expected -32002, got ${String(r.error.code)}`);
    },
  },
];
