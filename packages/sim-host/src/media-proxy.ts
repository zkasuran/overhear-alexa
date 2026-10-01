// The media proxy. The browser never calls the episode server directly (its Origin is refused by the
// server and a cross-origin audio fetch for the Web Audio graph would be blocked anyway), so audio is
// fetched through the host instead. The host forwards GET /media/:token to the server, adds the CORS
// header the browser needs to decode the bytes, and passes Range through for seeking. No bearer is
// attached: the media token is itself the capability (see SECURITY.md).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";

/** A conservative ceiling on a proxied media body. Episode parts are a few hundred KB. */
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Rewrite a server audio URL to one the browser fetches through this host. Absolute URLs pass through. */
export function proxyAudioUrl(audioUrl: string, publicBase: string): string {
  if (audioUrl.startsWith("/media/")) return `${publicBase}${audioUrl}`;
  return audioUrl;
}

/** The token in a /media/:token path, or null when the path is not a well-formed media request. */
export function mediaTokenOf(pathname: string): string | null {
  const prefix = "/media/";
  if (!pathname.startsWith(prefix)) return null;
  const token = decodeURIComponent(pathname.slice(prefix.length));
  return TOKEN_RE.test(token) ? token : null;
}

function allowOrigin(config: Config, reqOrigin: string | undefined): string {
  if (config.webOrigins.length === 0) return reqOrigin ?? "*";
  if (reqOrigin !== undefined && config.webOrigins.includes(reqOrigin)) return reqOrigin;
  return config.webOrigins[0] ?? "*";
}

/**
 * Handle a media request. Returns true when it owned the request (always, for a /media path), false
 * when the path is not ours so the caller can answer. OPTIONS is a CORS preflight; GET and HEAD proxy.
 */
export async function handleMedia(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  log: Logger,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://local");
  if (!url.pathname.startsWith("/media/")) return false;

  const cors = allowOrigin(config, req.headers.origin);
  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": cors,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "range",
    Vary: "Origin",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...corsHeaders, Allow: "GET, HEAD, OPTIONS" });
    res.end();
    return true;
  }

  const token = mediaTokenOf(url.pathname);
  if (token === null) {
    res.writeHead(404, corsHeaders);
    res.end();
    return true;
  }

  const target = `${config.serverOrigin}/media/${token}`;
  const headers: Record<string, string> = {};
  const range = req.headers.range;
  if (typeof range === "string") headers.range = range;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const declared = Number(upstream.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
      res.writeHead(502, corsHeaders);
      res.end();
      return true;
    }
    const outHeaders: Record<string, string> = { ...corsHeaders };
    for (const h of ["content-type", "content-length", "accept-ranges", "content-range"]) {
      const v = upstream.headers.get(h);
      if (v !== null) outHeaders[h] = v;
    }
    outHeaders["Cache-Control"] = "private, max-age=300";
    if (req.method === "HEAD" || upstream.body === null) {
      res.writeHead(upstream.status, outHeaders);
      res.end();
      return true;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.byteLength > MAX_MEDIA_BYTES) {
      res.writeHead(502, corsHeaders);
      res.end();
      return true;
    }
    res.writeHead(upstream.status, outHeaders);
    res.end(buf);
  } catch (err) {
    log.warn("media proxy failed", { token, error: String(err) });
    if (!res.headersSent) res.writeHead(502, corsHeaders);
    res.end();
  }
  return true;
}
