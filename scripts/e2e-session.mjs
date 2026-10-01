#!/usr/bin/env node
// End-to-end session over raw HTTP against a running Overhear server in mock mode. It drives the real
// tool-call order a producer would: initialize, plan an episode from a source file, render it as a
// task, watch the manifest until a part has playable audio, resolve a moment, ask a grounded question
// and read the episode back. It also fetches the served audio to prove the /media route works. Any
// failure exits non-zero so verify.sh fails loudly.
//
// Usage: node scripts/e2e-session.mjs [--mock] [url]   (default url http://127.0.0.1:8787/mcp)

import { readFile } from "node:fs/promises";

const args = process.argv.slice(2).filter((a) => a !== "--mock");
const URL_ARG = args[0] ?? process.env.OVERHEAR_URL ?? "http://127.0.0.1:8787/mcp";
const ORIGIN = new globalThis.URL(URL_ARG).origin;
const PV = "2025-11-25";
const REQ_TIMEOUT_MS = 20000;
const POLL_TRIES = 80;
const POLL_INTERVAL_MS = 500;

const token = (await readFile("fixtures/test-token", "utf8")).trim();
const article = await readFile("fixtures/sources/article.txt", "utf8");

let nextId = 1;
const order = [];

function fail(message) {
  console.error(`e2e: FAIL ${message}`);
  process.exit(1);
}

/** Parse one SSE or JSON HTTP response into the JSON-RPC message matching `id` (or the first message). */
function pickMessage(messages, id) {
  if (id === undefined) return messages[0];
  return messages.find((m) => m && typeof m === "object" && m.id === id);
}

/** POST a JSON-RPC message and return { status, sid, message } reading SSE or JSON transparently. */
async function postRpc(body, sid) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PV,
    Authorization: `Bearer ${token}`,
  };
  if (sid) headers["MCP-Session-Id"] = sid;
  const res = await fetch(URL_ARG, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });
  const ct = res.headers.get("content-type") ?? "";
  const outSid = res.headers.get("mcp-session-id") ?? undefined;
  const messages = [];
  if (ct.includes("text/event-stream") && res.body) {
    const text = await res.text();
    for (const chunk of text.split("\n")) {
      const line = chunk.replace(/\r$/, "");
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "") continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        /* skip non-JSON frames */
      }
    }
  } else {
    const raw = await res.text();
    if (raw.trim() !== "") {
      try {
        messages.push(JSON.parse(raw));
      } catch {
        /* leave empty */
      }
    }
  }
  return { status: res.status, sid: outSid, message: pickMessage(messages, body.id) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callTool(name, args, sid, task) {
  const params = { name, arguments: args };
  if (task) params.task = task;
  const { message } = await postRpc(
    { jsonrpc: "2.0", id: nextId++, method: "tools/call", params },
    sid,
  );
  if (!message) fail(`${name}: no response`);
  if (message.error)
    fail(`${name}: JSON-RPC error ${message.error.code} ${message.error.message ?? ""}`);
  if (message.result?.isError === true) {
    const text = message.result.content?.[0]?.text ?? "";
    fail(`${name}: tool error: ${text}`);
  }
  return message.result;
}

async function readManifest(episodeId, sid) {
  const uri = `overhear://episodes/${episodeId}/manifest`;
  const { message } = await postRpc(
    { jsonrpc: "2.0", id: nextId++, method: "resources/read", params: { uri } },
    sid,
  );
  if (!message || message.error) return undefined;
  const text = message.result?.contents?.[0]?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// 1. Initialize.
const init = await postRpc({
  jsonrpc: "2.0",
  id: nextId++,
  method: "initialize",
  params: {
    protocolVersion: PV,
    capabilities: {},
    clientInfo: { name: "overhear-e2e", version: "1.0.0" },
  },
});
if (init.status !== 200) fail(`initialize HTTP ${init.status}`);
if (!init.sid) fail("initialize returned no session id");
if (init.message?.result?.protocolVersion !== PV)
  fail("initialize did not negotiate the protocol version");
const sid = init.sid;
order.push("initialize");
await postRpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sid);

// 2. Plan an episode from the source file.
const plan = await callTool(
  "plan_episode",
  { source: { kind: "text", value: article }, minutes: 2, format: "explainer" },
  sid,
);
const episodeId = plan?.structuredContent?.episodeId;
if (typeof episodeId !== "string") fail("plan_episode returned no episodeId");
order.push("plan_episode");

// 3. Render as a task.
const render = await callTool("render_episode", { episodeId, fromPart: 0 }, sid, {
  ttl: 600000,
  pollInterval: 1000,
});
if (!render?.task?.taskId) fail("render_episode did not return a task");
order.push("render_episode");

// 4. Watch the manifest until a part has playable audio.
let readyPart;
for (let i = 0; i < POLL_TRIES && !readyPart; i++) {
  const manifest = await readManifest(episodeId, sid);
  const parts = Array.isArray(manifest?.parts) ? manifest.parts : [];
  readyPart = parts.find(
    (p) => p && p.status === "ready" && p.audio && typeof p.audio.url === "string",
  );
  if (!readyPart) await sleep(POLL_INTERVAL_MS);
}
if (!readyPart) fail("no part reached ready audio within the poll window");
order.push("manifest_ready");

// 5. Resolve a moment, 6. ask a grounded question, 7. read the episode back.
await callTool(
  "find_moment",
  { episodeId, query: "next", from: { partId: readyPart.partId, offsetMs: 0 } },
  sid,
);
order.push("find_moment");
await callTool(
  "ask",
  {
    episodeId,
    question: "What is this episode about?",
    at: { partId: readyPart.partId, offsetMs: 0 },
  },
  sid,
);
order.push("ask");
await callTool("get_episode", { episodeId }, sid);
order.push("get_episode");

// 8. Prove the served audio is reachable through the /media route.
const mediaUrl = `${ORIGIN}${readyPart.audio.url}`;
const audio = await fetch(mediaUrl, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
if (audio.status !== 200) fail(`media fetch HTTP ${audio.status} for ${mediaUrl}`);
const audioType = audio.headers.get("content-type") ?? "";
if (!audioType.includes("audio/mpeg")) fail(`media content-type was ${audioType}`);
await audio.arrayBuffer();

// 9. Assert the tool-call order.
const expected = [
  "initialize",
  "plan_episode",
  "render_episode",
  "manifest_ready",
  "find_moment",
  "ask",
  "get_episode",
];
if (order.join(",") !== expected.join(",")) {
  fail(`tool-call order was ${order.join(",")}, expected ${expected.join(",")}`);
}

console.log(
  `e2e: PASS  episode=${episodeId}  readyPart=${readyPart.partId}  order=${order.join(" -> ")}`,
);
process.exit(0);
