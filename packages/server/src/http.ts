// The Hono app. Three surfaces on one process:
//   POST|GET|DELETE /mcp   the Streamable HTTP MCP endpoint, guarded then handed to a per-session transport
//   GET /health            liveness and run-mode, no auth
//   GET /media/:token      local audio by capability token, no auth (the token is the capability)
//
// The guards run in a fixed order before any request reaches a transport, because the transport does
// not enforce Origin, auth or a 404 for an unknown session on its own (see SECURITY.md): an invalid
// Origin is 403, a missing or wrong bearer is 401, an unsupported protocol header is 400, a POST that
// does not accept both media types is 406, a non-initialize request without a known session is 400 or
// 404, a notification or response is acknowledged with 202 and a body over the ceiling is 413. A
// session is also bound to its principal: a request whose session is owned by another principal is 404,
// never a hint that the session exists.

import { Hono } from "hono";
import type { Context } from "hono";
import { readFile, stat } from "node:fs/promises";
import { JSON_BODY_MAX_BYTES } from "@overhear/core";
import {
  isInitializeRequest,
  isJSONRPCRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EventStore } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config, Logger } from "./contracts.js";
import type { AuthVerifier } from "./auth.js";
import type { QuotaTracker } from "./quota.js";
import type { SessionRegistry } from "./sessions.js";
import type { SessionFactory } from "./transport.js";
import { startSession } from "./transport.js";
import { resolveMediaToken } from "./adapters/index.js";

export interface AppDeps {
  config: Config;
  log: Logger;
  sessions: SessionRegistry;
  verifier: AuthVerifier;
  quota: QuotaTracker;
  /** Builds a fresh McpServer per session (the connected MCP handling for a request). */
  createServer: () => McpServer;
  /** Builds a fresh event store per session. */
  makeEventStore: () => EventStore;
}

const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);

/** A JSON-RPC error body with no id, used for transport-level refusals. */
function errorBody(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** An HTTP response carrying a JSON-RPC error body and status, plus any extra headers. */
function rpcErrorResponse(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(errorBody(code, message), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Auth context handed to the MCP handlers. Carries the principal, never the raw token. */
function authInfoFor(principal: string): {
  token: string;
  clientId: string;
  scopes: string[];
  extra: { principal: string };
} {
  return { token: principal, clientId: principal, scopes: [], extra: { principal } };
}

type BodyRead = { tooLarge: true } | { tooLarge: false; text: string };

/**
 * Read a request body into text with a hard byte ceiling. The declared Content-Length is checked
 * first for a cheap refusal, then the stream is read and aborted the moment it crosses the ceiling, so
 * a hostile body can never exhaust memory before the check (see SECURITY.md).
 */
async function readBodyLimited(req: Request, maxBytes: number): Promise<BodyRead> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return { tooLarge: true };
  }
  if (req.body === null) return { tooLarge: false, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { tooLarge: false, text: new TextDecoder().decode(joined) };
}

/** True when the Origin is present and not on the allowlist. Empty allowlist refuses every Origin. */
function originRefused(origin: string | null, allowlist: readonly string[]): boolean {
  return origin !== null && !allowlist.includes(origin);
}

/** The request id of a `plan_episode` tools/call in the parsed messages, else undefined. */
function planEpisodeRequestId(messages: readonly unknown[]): string | number | undefined {
  for (const message of messages) {
    if (!isJSONRPCRequest(message)) continue;
    if (message.method !== "tools/call") continue;
    const params = message.params;
    if (typeof params !== "object" || params === null) continue;
    if ((params as { name?: unknown }).name !== "plan_episode") continue;
    const id = message.id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return undefined;
}

/** Parse a single `bytes=start-end` range against a known size. Returns null for absent or unusable. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  let start: number;
  let end: number;
  if (startRaw === "") {
    if (endRaw === "") return null;
    const suffix = Number(endRaw);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? size - 1 : Number(endRaw);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= size) {
    return null;
  }
  return { start, end };
}

/** Serve a local media file by capability token. 404 for a bad or unknown token. Supports Range. */
async function serveMedia(c: Context, mediaDir: string): Promise<Response> {
  const token = c.req.param("token");
  const file = token === undefined ? null : resolveMediaToken(token, mediaDir);
  if (file === null) return new Response("not found", { status: 404 });
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return new Response("not found", { status: 404 });
    size = info.size;
  } catch {
    return new Response("not found", { status: 404 });
  }
  const common = {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "private, max-age=300",
    "Accept-Ranges": "bytes",
  };
  const range = parseRange(c.req.header("range") ?? null, size);
  const bytes = await readFile(file);
  if (range !== null) {
    const slice = bytes.subarray(range.start, range.end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        ...common,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(slice.byteLength),
      },
    });
  }
  return new Response(bytes, {
    status: 200,
    headers: { ...common, "Content-Length": String(size) },
  });
}

/** Guard an /mcp request in order, then hand it to the per-session transport. */
async function handleMcp(deps: AppDeps, factory: SessionFactory, c: Context): Promise<Response> {
  const req = c.req.raw;
  const method = req.method;
  if (!MCP_METHODS.has(method)) {
    return rpcErrorResponse(405, -32000, "Method Not Allowed", { Allow: "GET, POST, DELETE" });
  }
  if (originRefused(req.headers.get("origin"), deps.config.originAllowlist)) {
    return rpcErrorResponse(403, -32000, "Origin not allowed");
  }
  const principal = deps.verifier.verifyBearer(req.headers.get("authorization"));
  if (principal === null) {
    return rpcErrorResponse(401, -32001, "Unauthorized", { "WWW-Authenticate": "Bearer" });
  }
  const protocolHeader = req.headers.get("mcp-protocol-version");
  if (protocolHeader !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolHeader)) {
    return rpcErrorResponse(400, -32000, `Unsupported MCP-Protocol-Version: ${protocolHeader}`);
  }
  const authInfo = authInfoFor(principal);

  if (method === "GET" || method === "DELETE") {
    const sessionId = req.headers.get("mcp-session-id");
    if (sessionId === null) return rpcErrorResponse(400, -32000, "Missing MCP-Session-Id");
    const entry = deps.sessions.get(sessionId);
    if (entry === undefined || entry.principal !== principal) {
      return rpcErrorResponse(404, -32001, "Session not found");
    }
    return entry.transport.handleRequest(req, { authInfo });
  }

  const accept = req.headers.get("accept") ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    return rpcErrorResponse(
      406,
      -32000,
      "Not Acceptable: accept application/json and text/event-stream",
    );
  }
  const body = await readBodyLimited(req, JSON_BODY_MAX_BYTES);
  if (body.tooLarge) return rpcErrorResponse(413, -32000, "Payload Too Large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return rpcErrorResponse(400, -32700, "Parse error: invalid JSON");
  }
  const messages = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];

  if (messages.some(isInitializeRequest)) {
    const transport = await startSession(factory, principal);
    return transport.handleRequest(req, { parsedBody: parsed, authInfo });
  }

  const sessionId = req.headers.get("mcp-session-id");
  if (sessionId === null) return rpcErrorResponse(400, -32000, "Missing MCP-Session-Id");
  const entry = deps.sessions.get(sessionId);
  if (entry === undefined || entry.principal !== principal) {
    return rpcErrorResponse(404, -32001, "Session not found");
  }

  if (!messages.some(isJSONRPCRequest)) {
    return new Response(null, { status: 202 });
  }

  // Per-principal daily episode budget. Planning drives a model call plus speculative rendering, the
  // costliest entry point, so cap it before dispatch (see SECURITY.md). Over budget is a tool
  // execution error the producer can read aloud, never a protocol error.
  const planId = planEpisodeRequestId(messages);
  if (planId !== undefined && !deps.quota.checkAndReserve(principal, "episode").ok) {
    const result = {
      jsonrpc: "2.0",
      id: planId,
      result: {
        content: [
          {
            type: "text",
            text: "You have reached today's limit for new episodes. Try again tomorrow.",
          },
        ],
        isError: true,
      },
    };
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return entry.transport.handleRequest(req, { parsedBody: parsed, authInfo });
}

/** Build the Hono app with the MCP endpoint, health and media routes wired to the given deps. */
export function createApp(deps: AppDeps): Hono {
  const factory: SessionFactory = {
    sessions: deps.sessions,
    createServer: deps.createServer,
    makeEventStore: deps.makeEventStore,
    log: deps.log,
  };
  const app = new Hono();
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      mode: deps.config.modelsMode,
      store: deps.config.storeMode,
      text:
        deps.config.modelsMode === "mock"
          ? "mock"
          : deps.config.text.provider === "openai"
            ? deps.config.text.model
            : deps.config.bedrock.scriptModelId,
      speech: deps.config.modelsMode === "mock" ? "mock" : "amazon-polly",
    }),
  );
  app.get("/media/:token", (c) => serveMedia(c, deps.config.mediaDir));
  app.all("/mcp", (c) => handleMcp(deps, factory, c));
  return app;
}
