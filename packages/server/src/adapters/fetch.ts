// SSRF-guarded source fetcher with readable-text extraction for source.kind = "url".
// https only. DNS is resolved once, every resolved address is checked against the refused
// ranges (loopback, private, link-local, CGNAT, ULA, multicast, cloud metadata and the
// IPv4-mapped forms of all of them), the checked IP is pinned for the connection so DNS
// cannot be re-resolved to a different address mid-connect. Every redirect hop is
// re-checked the same way. Size, time and content-type ceilings come from @overhear/core.
// The DNS resolver and the dialer are injectable so the guard runs for real in tests
// without touching DNS or the network. See SECURITY.md.

import { BlockList, isIP, isIPv4, isIPv6 } from "node:net";
import type { LookupFunction } from "node:net";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { MAX_FETCH_BYTES, FETCH_TIMEOUT_MS, MAX_REDIRECTS, MAX_SOURCE_CHARS } from "@overhear/core";
import type { FetchService, FetchedSource, Logger } from "../contracts.js";

// Every range we refuse to connect to. net.BlockList also matches an IPv4-mapped IPv6
// address against the IPv4 subnets; we extract the embedded v4 ourselves too so a refusal
// never depends on that behaviour.
const REFUSED = new BlockList();
REFUSED.addSubnet("0.0.0.0", 8, "ipv4"); // unspecified / this host
REFUSED.addSubnet("10.0.0.0", 8, "ipv4"); // private
REFUSED.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
REFUSED.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
REFUSED.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, holds 169.254.169.254 metadata
REFUSED.addSubnet("172.16.0.0", 12, "ipv4"); // private
REFUSED.addSubnet("192.168.0.0", 16, "ipv4"); // private
REFUSED.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
REFUSED.addAddress("255.255.255.255", "ipv4"); // broadcast
REFUSED.addAddress("::", "ipv6"); // unspecified
REFUSED.addAddress("::1", "ipv6"); // loopback
REFUSED.addSubnet("fc00::", 7, "ipv6"); // unique local (ULA)
REFUSED.addSubnet("fe80::", 10, "ipv6"); // link-local
REFUSED.addSubnet("ff00::", 8, "ipv6"); // multicast
// Embedded IPv4 of an IPv4-mapped IPv6 address. Returns null when there is none. Handles
// ::ffff:1.2.3.4 and the hex form ::ffff:0102:0304.
function mappedV4(ip: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip)?.[1];
  if (dotted !== undefined && isIPv4(dotted)) return dotted;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  const h1 = hex?.[1];
  const h2 = hex?.[2];
  if (h1 !== undefined && h2 !== undefined) {
    const hi = parseInt(h1, 16);
    const lo = parseInt(h2, 16);
    const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    return isIPv4(v4) ? v4 : null;
  }
  return null;
}

/** True if `ip` is a loopback, private, link-local, CGNAT, ULA, multicast, broadcast,
 * metadata or IPv4-mapped form of any of those. Unparseable input fails closed (refused).
 * Exported so the classifier can be unit tested directly. */
export function isRefusedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true; // not an IP: refuse rather than guess
  if (family === 4) return REFUSED.check(ip, "ipv4");
  if (REFUSED.check(ip, "ipv6")) return true;
  const v4 = mappedV4(ip);
  return v4 !== null && REFUSED.check(v4, "ipv4");
}
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  deg: "°",
  middot: "·",
  euro: "€",
  pound: "£",
  cent: "¢",
};

function fromCode(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

// Decode the common named and numeric HTML entities. Unknown entities are left as written.
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m: string, body: string): string => {
    const b = body.toLowerCase();
    if (b.startsWith("#x")) return fromCode(parseInt(b.slice(2), 16), m);
    if (b.startsWith("#")) return fromCode(parseInt(b.slice(1), 10), m);
    return NAMED_ENTITIES[b] ?? m;
  });
}

// Reduce an HTML document to its readable text. Comments and the whole script, style and
// noscript elements go, remaining tags become spaces, then entities are decoded.
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped);
}

// Readable text from a body. HTML is reduced to text, plain text passes through, then
// whitespace is collapsed and the result is capped at MAX_SOURCE_CHARS.
function extractReadableText(body: string, mime: string): string {
  const raw = mime === "text/html" ? htmlToText(body) : body;
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_SOURCE_CHARS);
}
export interface DialRequest {
  url: URL;
  pinnedIp: string;
  host: string;
  signal: AbortSignal;
}

export interface DialResponse {
  statusCode: number;
  contentType: string | undefined;
  location: string | undefined;
  stream: AsyncIterable<Uint8Array>;
  destroy: () => void;
}

export type Dialer = (req: DialRequest) => Promise<DialResponse>;

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Default transport: TLS to the pre-checked IP, pinned through the socket `lookup` option
// so the address cannot change under us, while the original host carries the SNI and the
// Host header. Redirects are NOT followed here; fetchUrl re-checks every hop.
function httpsDial(req: DialRequest): Promise<DialResponse> {
  return new Promise<DialResponse>((resolve, reject) => {
    const family = isIPv6(req.pinnedIp) ? 6 : 4;
    const pinnedLookup: LookupFunction = (_hostname, options, cb) => {
      if (options.all === true) cb(null, [{ address: req.pinnedIp, family }]);
      else cb(null, req.pinnedIp, family);
    };
    const request = httpsRequest(
      req.url,
      {
        method: "GET",
        servername: req.host,
        headers: {
          Host: req.host,
          Accept: "text/html, text/plain",
          "User-Agent": "Overhear/1.0 (+https://github.com/zkasuran/overhear-alexa)",
        },
        signal: req.signal,
        lookup: pinnedLookup,
      },
      (res) => {
        resolve({
          statusCode: res.statusCode ?? 0,
          contentType: firstHeader(res.headers["content-type"]),
          location: firstHeader(res.headers["location"]),
          stream: res,
          destroy: () => res.destroy(),
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export interface FetchDeps {
  lookup?: (host: string) => Promise<string[]>;
  dial?: Dialer;
}

/** Build the SSRF-guarded fetcher. `deps.lookup` and `deps.dial` are injected in tests so
 * the guard runs for real without touching DNS or the network. */
export function makeFetchService(log: Logger, deps: FetchDeps = {}): FetchService {
  const flog = log.child({ component: "fetch" });
  const dial = deps.dial ?? httpsDial;
  const resolveHost =
    deps.lookup ??
    (async (host: string): Promise<string[]> => {
      if (isIP(host) !== 0) return [host];
      const addrs = await dnsLookup(host, { all: true });
      return addrs.map((a) => a.address);
    });

  // https only; resolve, refuse if ANY resolved address is blocked, return the pinned IP.
  async function checkDestination(target: URL): Promise<string> {
    if (target.protocol !== "https:") {
      throw new Error(`refusing non-https url (${target.protocol})`);
    }
    const host = target.hostname;
    const addresses = await resolveHost(host);
    const pinned = addresses[0];
    if (pinned === undefined) throw new Error(`could not resolve host: ${host}`);
    for (const addr of addresses) {
      if (isRefusedAddress(addr)) {
        flog.warn("refused source address", { host, blocked: addr });
        throw new Error(`refusing url: ${host} resolves to a blocked address`);
      }
    }
    return pinned;
  }
  // Read the body with a hard byte cap, aborting the stream the moment it is exceeded.
  async function readCappedBody(resp: DialResponse): Promise<string> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of resp.stream) {
        total += chunk.byteLength;
        if (total > MAX_FETCH_BYTES) {
          resp.destroy();
          throw new Error(`source exceeds MAX_FETCH_BYTES (${MAX_FETCH_BYTES})`);
        }
        chunks.push(chunk);
      }
    } catch (err) {
      resp.destroy();
      throw err instanceof Error ? err : new Error("source stream failed");
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks, total));
  }

  async function fetchUrl(url: string, opts?: { signal?: AbortSignal }): Promise<FetchedSource> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error("invalid url");
    }
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    // One hop per iteration. The destination is re-checked at the top every time, so a
    // redirect is held to the same rules as the first request.
    for (let redirects = 0; ; redirects += 1) {
      const pinnedIp = await checkDestination(target);
      const resp = await dial({ url: target, pinnedIp, host: target.hostname, signal });

      if (REDIRECT_STATUSES.has(resp.statusCode)) {
        resp.destroy();
        if (resp.location === undefined) throw new Error("redirect without location");
        if (redirects >= MAX_REDIRECTS) throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
        try {
          target = new URL(resp.location, target);
        } catch {
          throw new Error("invalid redirect location");
        }
        continue;
      }

      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.destroy();
        throw new Error(`upstream responded ${resp.statusCode}`);
      }

      const mime = (resp.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (mime !== "text/html" && mime !== "text/plain") {
        resp.destroy();
        throw new Error(`refusing content-type: ${resp.contentType ?? "(none)"}`);
      }

      const body = await readCappedBody(resp);
      return {
        text: extractReadableText(body, mime),
        contentType: mime,
        finalUrl: target.toString(),
      };
    }
  }

  return { fetchUrl };
}
