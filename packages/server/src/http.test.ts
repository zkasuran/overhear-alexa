import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SqliteEventStore } from "@overhear/durable-stores";
import { EPISODES_PER_DAY, JSON_BODY_MAX_BYTES } from "@overhear/core";
import { loadConfig } from "./config.js";
import { nullLogger } from "./log.js";
import { makeAuthVerifier, parseTokenTable } from "./auth.js";
import { makeQuotaTracker } from "./quota.js";
import { makeSessionRegistry } from "./sessions.js";
import type { SessionRegistry } from "./sessions.js";
import { createApp } from "./http.js";
import type { QuotaTracker } from "./quota.js";

const TOKEN = "alpha";
const digest = createHash("sha256").update(TOKEN).digest("hex");
const TOKEN2 = "bravo";
const digest2 = createHash("sha256").update(TOKEN2).digest("hex");
const PV = "2025-11-25";

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: PV, capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": PV,
    ...extra,
  };
}

type App = ReturnType<typeof createApp>;
let app: App;
let sessions: SessionRegistry;
let quota: QuotaTracker;

function build(withQuota?: QuotaTracker): void {
  const config = loadConfig({
    OVERHEAR_MODELS: "mock",
    OVERHEAR_STORE: "local",
    OVERHEAR_MEDIA_DIR: mkdtempSync(join(tmpdir(), "overhear-media-")),
    OVERHEAR_DATA_DIR: mkdtempSync(join(tmpdir(), "overhear-data-")),
  });
  sessions = makeSessionRegistry();
  quota = withQuota ?? makeQuotaTracker();
  app = createApp({
    config,
    log: nullLogger,
    sessions,
    verifier: makeAuthVerifier(parseTokenTable(`alice:${digest}\nbob:${digest2}`)),
    quota,
    createServer: () => new McpServer({ name: "overhear-test", version: "1.0.0" }, {}),
    makeEventStore: () => new SqliteEventStore({}),
  });
}

/** Open a session and return its id. Drains the SSE response body so no stream lingers. */
async function openSession(): Promise<string> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(INIT),
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get("mcp-session-id");
  await res.text().catch(() => undefined);
  expect(sid).not.toBeNull();
  return sid as string;
}

beforeEach(() => build());
afterEach(async () => {
  await sessions.closeAll();
});

describe("health and media", () => {
  it("GET /health is 200 with mode and store, no auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", mode: "mock", store: "local" });
  });

  it("GET /media with a bad token is 404", async () => {
    const res = await app.request("/media/not..a..token");
    expect(res.status).toBe(404);
  });
});

describe("/mcp guards (in order)", () => {
  it("401 with WWW-Authenticate when the bearer is missing", async () => {
    const h = headers();
    delete h.Authorization;
    const res = await app.request("/mcp", {
      method: "POST",
      headers: h,
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("401 when the bearer is wrong", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: headers({ Authorization: "Bearer nope" }),
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(401);
  });

  it("403 for a present, non-allowlisted Origin", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: headers({ Origin: "https://evil.example" }),
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(403);
  });

  it("400 for an unsupported MCP-Protocol-Version", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: headers({ "MCP-Protocol-Version": "1999-01-01" }),
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(400);
  });

  it("406 when Accept does not list both media types", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: headers({ Accept: "application/json" }),
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(406);
  });

  it("400 for a non-initialize request without a session", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("404 for an unknown session id", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: headers({ "MCP-Session-Id": "no-such-session" }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("413 for a body over the ceiling", async () => {
    const big = "A".repeat(JSON_BODY_MAX_BYTES + 1024);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { blob: big },
    });
    const res = await app.request("/mcp", { method: "POST", headers: headers(), body });
    expect(res.status).toBe(413);
  });

  it("405 for an unsupported method", async () => {
    const res = await app.request("/mcp", { method: "PUT", headers: headers() });
    expect(res.status).toBe(405);
  });
});

describe("/mcp session lifecycle", () => {
  it("initialize issues a session, a notification is 202, DELETE then reuse is 404", async () => {
    const sid = await openSession();

    const note = await app.request("/mcp", {
      method: "POST",
      headers: headers({ "MCP-Session-Id": sid }),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");

    const del = await app.request("/mcp", {
      method: "DELETE",
      headers: headers({ "MCP-Session-Id": sid }),
    });
    await del.text().catch(() => undefined);
    expect(del.status).toBeGreaterThanOrEqual(200);
    expect(del.status).toBeLessThan(300);

    const after = await app.request("/mcp", {
      method: "POST",
      headers: headers({ "MCP-Session-Id": sid }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    });
    expect(after.status).toBe(404);
  });

  it("rejects a session owned by another principal with 404", async () => {
    const sid = await openSession();
    // alice owns the session. bob is a valid principal but not its owner, so presenting alice's
    // session id under bob's bearer must resolve to 404, never a hint that the session exists.
    const res = await app.request("/mcp", {
      method: "POST",
      headers: headers({ Authorization: `Bearer ${TOKEN2}`, "MCP-Session-Id": sid }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
  });
});

describe("/mcp per-principal episode budget", () => {
  it("returns a speakable tool error once the daily episode cap is spent", async () => {
    const spent = makeQuotaTracker();
    for (let i = 0; i < EPISODES_PER_DAY; i++) spent.checkAndReserve("alice", "episode");
    build(spent);
    const sid = await openSession();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: headers({ "MCP-Session-Id": sid }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "plan_episode", arguments: { source: { kind: "topic", value: "x" } } },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const payload = (await res.json()) as { result?: { isError?: boolean } };
    expect(payload.result?.isError).toBe(true);
  });
});
