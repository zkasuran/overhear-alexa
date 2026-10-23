// Entry point for the Overhear Alexa skill endpoint. One small HTTP server:
//   POST /alexa         the skill endpoint (Alexa request verification on by default)
//   GET  /media/:token  episode audio, proxied from the Overhear server, so the Echo can stream it
//   GET  /health        liveness
// Put an https tunnel in front of it and set ALEXA_PUBLIC_BASE to that origin. The bearer token for the
// MCP server is read from a file and only ever sent to the MCP server.
//
//   SIM_SERVER_URL=http://127.0.0.1:8787/mcp SIM_TOKEN_FILE=fixtures/test-token \
//   ALEXA_PUBLIC_BASE=https://<tunnel> ALEXA_SKILL_ID=amzn1.ask.skill.<id> \
//   node packages/sim-host/dist/alexa/main.js

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { consoleLogger } from "../log.js";
import { OverhearClient } from "../mcp-client.js";
import { mediaTokenOf } from "../media-proxy.js";
import { makeSkill } from "./skill.js";
import { VerifyError, verifyAlexaRequest } from "./verify.js";

const MAX_BODY_BYTES = 256 * 1024;
const MEDIA_TIMEOUT_MS = 15_000;

const log = consoleLogger();
const serverUrl = process.env.SIM_SERVER_URL ?? "http://127.0.0.1:8787/mcp";
const serverOrigin = new URL(serverUrl).origin;
const token = readFileSync(process.env.SIM_TOKEN_FILE ?? "fixtures/test-token", "utf8").trim();
const publicBase = (process.env.ALEXA_PUBLIC_BASE ?? "").replace(/\/+$/, "");
const skillId = process.env.ALEXA_SKILL_ID ?? "";
const skipVerify = process.env.ALEXA_SKIP_VERIFY === "1";
const port = Number(process.env.ALEXA_PORT ?? "8790");

if (!publicBase.startsWith("https://")) {
  log.error("ALEXA_PUBLIC_BASE must be the https origin of the tunnel in front of this process");
  process.exit(2);
}
if (skipVerify)
  log.warn("ALEXA_SKIP_VERIFY=1: request signatures are NOT checked (local testing only)");

const client = new OverhearClient(serverUrl, token, log);
await client.connect();
const skill = makeSkill({ api: client, log, publicBase });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function onAlexa(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    res.writeHead(400).end();
    return;
  }
  const request = (env.request ?? {}) as Record<string, unknown>;
  if (!skipVerify) {
    try {
      await verifyAlexaRequest(
        raw,
        {
          certUrl: header(req, "signaturecertchainurl"),
          signature256: header(req, "signature-256"),
        },
        request.timestamp,
      );
    } catch (err) {
      log.warn("alexa: request refused", {
        reason: err instanceof VerifyError ? err.message : "error",
      });
      res.writeHead(400).end();
      return;
    }
  }
  const sys = ((env.context ?? {}) as Record<string, unknown>).System as
    | Record<string, unknown>
    | undefined;
  const appId =
    ((sys?.application ?? {}) as Record<string, unknown>).applicationId ??
    (
      ((env.session ?? {}) as Record<string, unknown>).application as
        | Record<string, unknown>
        | undefined
    )?.applicationId;
  if (skillId && appId !== skillId) {
    log.warn("alexa: wrong skill id");
    res.writeHead(400).end();
    return;
  }
  const out = await skill.handle(env);
  const body = JSON.stringify(out);
  res.writeHead(200, { "content-type": "application/json;charset=UTF-8" }).end(body);
}

async function onMedia(
  req: IncomingMessage,
  res: ServerResponse,
  mediaToken: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  const range = header(req, "range");
  if (range) headers.range = range;
  const upstream = await fetch(`${serverOrigin}/media/${encodeURIComponent(mediaToken)}`, {
    method: req.method === "HEAD" ? "HEAD" : "GET",
    headers,
    signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
  });
  const pass: Record<string, string> = {};
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) pass[h] = v;
  }
  res.writeHead(upstream.status, pass);
  if (req.method === "HEAD" || !upstream.body) {
    res.end();
    return;
  }
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  const done = (p: Promise<void>): void => {
    p.catch((err: unknown) => {
      log.error("alexa endpoint error", { error: String(err) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
  if (req.method === "POST" && url.pathname === "/alexa") return done(onAlexa(req, res));
  const mediaToken = mediaTokenOf(url.pathname);
  if (mediaToken && (req.method === "GET" || req.method === "HEAD"))
    return done(onMedia(req, res, mediaToken));
  if (url.pathname === "/health") return void res.writeHead(200).end("ok");
  res.writeHead(404).end();
}).listen(port, "127.0.0.1", () => {
  log.info("overhear alexa skill endpoint", { port, publicBase, verify: !skipVerify });
});
