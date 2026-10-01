import { afterEach, describe, expect, test } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_FETCH_BYTES } from "@overhear/core";
import type { Logger } from "../contracts.js";
import { isRefusedAddress, makeFetchService } from "./fetch.js";
import type { Dialer, DialResponse } from "./fetch.js";

// A logger that drops everything. The guard logs a refusal; the tests assert on the thrown
// error, not the log.
const noopLog: Logger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog;
  },
};

// Transport seam for the tests: the REAL guard runs (resolve, refuse, re-check each hop),
// then the pinned connection is routed to a local http server on loopback instead of the
// public IP it checked. Only the socket target changes; the SSRF logic is unchanged. This
// is the sanctioned test seam, not a weakened guard.
function loopbackDial(port: number): Dialer {
  return (req) =>
    new Promise<DialResponse>((resolve, reject) => {
      const r = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "GET",
          path: req.url.pathname + req.url.search,
          headers: { Host: req.host },
        },
        (res) => {
          const ct = res.headers["content-type"];
          const loc = res.headers["location"];
          resolve({
            statusCode: res.statusCode ?? 0,
            contentType: Array.isArray(ct) ? ct[0] : ct,
            location: Array.isArray(loc) ? loc[0] : loc,
            stream: res,
            destroy: () => res.destroy(),
          });
        },
      );
      r.on("error", reject);
      r.end();
    });
}
// Local servers started by a test, closed after it. 0 picks a free port on loopback.
const servers: Server[] = [];
function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  const server = createServer(handler);
  server.on("error", () => {}); // ignore client-abort resets during the byte-cap test
  servers.push(server);
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}
afterEach(async () => {
  const open = servers.splice(0);
  await Promise.all(
    open.map((s) => {
      s.closeAllConnections();
      return new Promise<void>((r) => s.close(() => r()));
    }),
  );
});

const PUBLIC_V4 = "93.184.216.34"; // public, in no refused range; stands in for a real host
function publicLookup(): Promise<string[]> {
  return Promise.resolve([PUBLIC_V4]);
}
const dialMustNotRun: Dialer = async () => {
  throw new Error("dial must not be reached: the guard should refuse before connecting");
};
describe("isRefusedAddress (classifier)", () => {
  const refused = [
    "127.0.0.1",
    "::1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "fe80::1",
    "fc00::1",
    "::ffff:169.254.169.254",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "2606:4700::1"];
  test.each(refused)("refuses %s", (ip) => {
    expect(isRefusedAddress(ip)).toBe(true);
  });
  test.each(allowed)("allows %s", (ip) => {
    expect(isRefusedAddress(ip)).toBe(false);
  });
});

describe("fetchUrl SSRF guard", () => {
  test("refuses http:// (non-https)", async () => {
    await expect(makeFetchService(noopLog).fetchUrl("http://example.com/")).rejects.toThrow(
      /non-https/i,
    );
  });

  test("refuses file:// and other schemes", async () => {
    await expect(makeFetchService(noopLog).fetchUrl("file:///etc/passwd")).rejects.toThrow(
      /non-https/i,
    );
  });

  test("refuses a public host that resolves to a private IP (ssrf-dns-rebind)", async () => {
    const svc = makeFetchService(noopLog, {
      lookup: async () => ["10.0.0.5"],
      dial: dialMustNotRun,
    });
    await expect(svc.fetchUrl("https://totally-public.example/")).rejects.toThrow(
      /blocked address/i,
    );
  });

  test("refuses when ANY resolved address is the metadata IP (ssrf-169.254)", async () => {
    const svc = makeFetchService(noopLog, {
      lookup: async () => [PUBLIC_V4, "169.254.169.254"],
      dial: dialMustNotRun,
    });
    await expect(svc.fetchUrl("https://mixed.example/")).rejects.toThrow(/blocked address/i);
  });

  test("refuses an ipv6-mapped metadata address (ssrf-ipv6-mapped)", async () => {
    const svc = makeFetchService(noopLog, {
      lookup: async () => ["::ffff:169.254.169.254"],
      dial: dialMustNotRun,
    });
    await expect(svc.fetchUrl("https://mapped.example/")).rejects.toThrow(/blocked address/i);
  });
  test("refuses a redirect to the metadata IP over http (ssrf-redirect)", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    const svc = makeFetchService(noopLog, { lookup: publicLookup, dial: loopbackDial(port) });
    await expect(svc.fetchUrl("https://pub.example/")).rejects.toThrow(/non-https/i);
  });

  test("refuses an https redirect to a host that resolves private (ssrf-redirect)", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(302, { Location: "https://rebind.internal/" });
      res.end();
    });
    const svc = makeFetchService(noopLog, {
      lookup: async (host) => (host === "rebind.internal" ? ["10.0.0.9"] : [PUBLIC_V4]),
      dial: loopbackDial(port),
    });
    await expect(svc.fetchUrl("https://pub.example/")).rejects.toThrow(/blocked address/i);
  });

  test("refuses a non-text content-type (application/json)", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"a":1}');
    });
    const svc = makeFetchService(noopLog, { lookup: publicLookup, dial: loopbackDial(port) });
    await expect(svc.fetchUrl("https://pub.example/")).rejects.toThrow(/content-type/i);
  });

  test("aborts a body larger than MAX_FETCH_BYTES", async () => {
    const port = await startServer((_req, res) => {
      res.on("error", () => {});
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(Buffer.alloc(MAX_FETCH_BYTES + 1024, 0x61));
    });
    const svc = makeFetchService(noopLog, { lookup: publicLookup, dial: loopbackDial(port) });
    await expect(svc.fetchUrl("https://pub.example/")).rejects.toThrow(/MAX_FETCH_BYTES/);
  });
  test("extracts readable text from html (script/style stripped, entities decoded)", async () => {
    const html =
      "<html><head><style>.a{color:red}</style><script>evil()</script></head>" +
      "<body><h1>Title</h1><p>Hello &amp; welcome &#128075;</p><!-- secret --></body></html>";
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    const svc = makeFetchService(noopLog, { lookup: publicLookup, dial: loopbackDial(port) });
    const out = await svc.fetchUrl("https://pub.example/article");
    expect(out.contentType).toBe("text/html");
    expect(out.finalUrl).toBe("https://pub.example/article");
    expect(out.text).toBe("Title Hello & welcome 👋");
  });

  test("passes plain text through, collapsing whitespace", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("line one\n\n   line two\t\tend");
    });
    const svc = makeFetchService(noopLog, { lookup: publicLookup, dial: loopbackDial(port) });
    const out = await svc.fetchUrl("https://pub.example/");
    expect(out.text).toBe("line one line two end");
    expect(out.contentType).toBe("text/plain");
  });

  test("follows an allowed redirect then extracts (hop re-checked, within MAX_REDIRECTS)", async () => {
    const port = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "https://pub.example/final" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<p>Arrived</p>");
    });
    const svc = makeFetchService(noopLog, { lookup: publicLookup, dial: loopbackDial(port) });
    const out = await svc.fetchUrl("https://pub.example/start");
    expect(out.text).toBe("Arrived");
    expect(out.finalUrl).toBe("https://pub.example/final");
  });
});
