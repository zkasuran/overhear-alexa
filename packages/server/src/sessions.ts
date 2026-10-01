// The connected-session registry. One entry per live MCP session: the owning principal, the transport
// that holds the session plus the McpServer bound to it. A session is created at `initialize` and
// removed on DELETE or expiry. The registry also resolves a transport session id to its durable
// principal scope, so the task stores bind a task to its owner rather than the transport id (see
// SECURITY.md): a client that reconnects under a fresh session still finds its own tasks while a second
// principal never does.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { EventStore } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { GLOBAL_SCOPE } from "@overhear/durable-stores";

export interface SessionEntry {
  principal: string;
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  eventStore: EventStore;
}

export interface SessionRegistry {
  get(sessionId: string): SessionEntry | undefined;
  has(sessionId: string): boolean;
  register(sessionId: string, entry: SessionEntry): void;
  remove(sessionId: string): SessionEntry | undefined;
  /** Resolve a transport session id to the durable principal scope the task stores partition on. */
  scope(sessionId: string | undefined): Promise<string>;
  size(): number;
  /** Close every live server. Best effort, for graceful shutdown. */
  closeAll(): Promise<void>;
}

export function makeSessionRegistry(): SessionRegistry {
  const sessions = new Map<string, SessionEntry>();
  return {
    get: (sessionId) => sessions.get(sessionId),
    has: (sessionId) => sessions.has(sessionId),
    register: (sessionId, entry) => {
      sessions.set(sessionId, entry);
    },
    remove: (sessionId) => {
      const entry = sessions.get(sessionId);
      sessions.delete(sessionId);
      return entry;
    },
    // Fail closed: an unknown session id scopes to itself, never to the shared global bucket, so a
    // stray lookup can never read another principal's tasks. Only a session-less call uses the global
    // scope, which matches the SDK default.
    scope: async (sessionId) =>
      sessionId === undefined ? GLOBAL_SCOPE : (sessions.get(sessionId)?.principal ?? sessionId),
    size: () => sessions.size,
    closeAll: async () => {
      const open = [...sessions.values()];
      sessions.clear();
      for (const entry of open) {
        await entry.server.close().catch(() => undefined);
      }
    },
  };
}
