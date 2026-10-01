// Per-session Streamable HTTP transport wiring. Each MCP session owns one transport and one McpServer:
// a fresh pair is built at `initialize` and connected, then the registry is populated from the
// transport's own session lifecycle hooks. The event store is created per session because the
// standalone SSE stream carries a fixed id, so one shared store would mix two sessions' streams on
// replay. Origin, auth and session routing are enforced before a request reaches a transport (http.ts);
// the transport owns the Streamable HTTP mechanics (SSE, resumability, DELETE) once it holds a session.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { EventStore } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JSON_BODY_MAX_BYTES, newSessionId } from "@overhear/core";
import type { Logger } from "./contracts.js";
import type { SessionRegistry } from "./sessions.js";

// Reconnection hint written into the SSE priming event so a client that drops waits this long before
// reopening the stream. The resumability replay keys off Last-Event-ID, not this value.
const SSE_RETRY_MS = 2000;

export interface SessionFactory {
  sessions: SessionRegistry;
  /** Builds a fresh McpServer for a new session. One server per session: the SDK binds a server to a
   * single transport, so a server is never shared across sessions. */
  createServer: () => McpServer;
  /** Builds a fresh event store for a new session. One per session isolates the standalone SSE stream. */
  makeEventStore: () => EventStore;
  log: Logger;
}

/**
 * Create a new transport and server for a session owned by `principal`, connect them then return the
 * transport. The session id is generated when the client's `initialize` reaches the transport; the
 * transport then calls `onsessioninitialized`, which registers the entry under the owning principal.
 * The caller invokes `transport.handleRequest(request)` to dispatch the initialize that triggered this.
 */
export async function startSession(
  factory: SessionFactory,
  principal: string,
): Promise<WebStandardStreamableHTTPServerTransport> {
  const server = factory.createServer();
  const eventStore = factory.makeEventStore();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId(),
    eventStore,
    retryInterval: SSE_RETRY_MS,
    maxRequestBodySize: JSON_BODY_MAX_BYTES,
    onsessioninitialized: (sessionId) => {
      factory.sessions.register(sessionId, { principal, transport, server, eventStore });
      factory.log.info("session initialized", { session: sessionId });
    },
    onsessionclosed: (sessionId) => {
      factory.sessions.remove(sessionId);
      factory.log.info("session closed", { session: sessionId });
    },
  });
  await server.connect(transport);
  return transport;
}
