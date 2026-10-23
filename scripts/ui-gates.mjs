// UI gate for the simulator. It serves the built UI, stands up a small in-process stub of the host (a
// WebSocket that replays a representative session plus a media endpoint that returns a real MP3), then
// loads the page in system Chrome at two widths in both themes. Each load must produce zero console
// errors and zero Content-Security-Policy violations, and a screenshot is written at deviceScaleFactor
// 2. This exercises the real UI: theme, device frame, outline, captions, the audio graph and the CSP.
// It does not drive the live episode server or the host process; those run as their own build.
//
// Chrome is the system binary at /usr/bin/google-chrome. Nothing is downloaded.

/* global window, document */

import { createServer } from "node:http";
import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import puppeteer from "puppeteer-core";

const ROOT = resolve(process.argv[2] ?? ".");
const DIST = join(ROOT, "packages/sim-web/dist");
const SCREENS = join(ROOT, "docs/assets/screens");
const CHROME = "/usr/bin/google-chrome";
const WEB_PORT = 4173;
const HOST_PORT = 8788;

if (!existsSync(join(DIST, "index.html"))) {
  console.error(`ui-gates: build missing at ${DIST}. Run: npm run build -w @overhear/sim-web`);
  process.exit(1);
}
mkdirSync(SCREENS, { recursive: true });

function sampleMp3() {
  const dir = join(ROOT, ".media");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".mp3")) : [];
  if (files.length === 0) return Buffer.alloc(0);
  // The smallest sample keeps decode fast and deterministic.
  let best = files[0];
  let bestSize = Infinity;
  for (const f of files) {
    const size = readFileSync(join(dir, f)).byteLength;
    if (size < bestSize) {
      bestSize = size;
      best = f;
    }
  }
  return readFileSync(join(dir, best));
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
};

function startStatic() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(DIST, path);
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(WEB_PORT, "127.0.0.1", () => r(server)));
}

const SESSION = [
  {
    at: 0,
    type: "status",
    mode: "mock",
    store: "local",
    producer: "push-to-talk",
    serverOk: true,
    label: "Mock mode: recorded sample audio, no keys needed.",
  },
  { at: 0, type: "ring", state: "idle" },
  {
    at: 150,
    type: "outline",
    episodeId: "ep_demo",
    title: "How tap water is treated",
    dek: "A two-host walk through coagulation, filtration and disinfection.",
    format: "explainer",
    totalEstSeconds: 150,
    speakable: "Here is how tap water is treated, about two minutes across three parts.",
    parts: [
      {
        index: 0,
        partId: "p0",
        heading: "Cold open",
        summary: "",
        estSeconds: 40,
        status: "pending",
        origin: "plan",
      },
      {
        index: 1,
        partId: "p1",
        heading: "Filtration",
        summary: "",
        estSeconds: 55,
        status: "pending",
        origin: "plan",
      },
      {
        index: 2,
        partId: "p2",
        heading: "What is next",
        summary: "",
        estSeconds: 55,
        status: "pending",
        origin: "plan",
      },
    ],
  },
  {
    at: 300,
    type: "part-status",
    partId: "p0",
    index: 0,
    status: "scripting",
    heading: "Cold open",
  },
  {
    at: 600,
    type: "caption",
    speaker: "producer",
    text: "Starting now. The first part plays as soon as it is ready.",
  },
  {
    at: 900,
    type: "part-ready",
    partId: "p0",
    index: 0,
    heading: "Cold open",
    origin: "plan",
    audio: { url: `http://127.0.0.1:${HOST_PORT}/media/sample`, seconds: 26 },
    lines: [
      {
        lineId: "l0",
        speaker: "host",
        text: "Every glass of tap water has already been through four stages.",
        startMs: 0,
        endMs: 5000,
      },
      {
        lineId: "l1",
        speaker: "expert",
        text: "Right, and each one targets a different risk.",
        startMs: 5000,
        endMs: 9000,
      },
    ],
  },
  {
    at: 1000,
    type: "part-status",
    partId: "p1",
    index: 1,
    status: "scripting",
    heading: "Filtration",
  },
  { at: 1300, type: "ducking", active: true },
  { at: 1700, type: "ducking", active: false },
];

function startStubHost(mp3) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname.startsWith("/media/")) {
      const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "audio/mpeg" };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      res.writeHead(200, { ...cors, "Content-Length": String(mp3.byteLength) });
      res.end(mp3);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    for (const event of SESSION) {
      setTimeout(() => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      }, event.at);
    }
    socket.on("message", () => {
      // The stub ignores commands; it only needs to accept the connection so the UI has no console error.
    });
    socket.on("error", () => {});
  });
  return new Promise((r) => server.listen(HOST_PORT, "127.0.0.1", () => r({ server, wss })));
}

const CONFIGS = [
  { theme: "light", width: 390, height: 844 },
  { theme: "dark", width: 390, height: 844 },
  { theme: "light", width: 1360, height: 900 },
  { theme: "dark", width: 1360, height: 900 },
];

async function main() {
  const mp3 = sampleMp3();
  const web = await startStatic();
  const host = await startStubHost(mp3);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const failures = [];
  const written = [];

  for (const cfg of CONFIGS) {
    const page = await browser.newPage();
    const problems = [];
    await page.evaluateOnNewDocument(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
    });
    page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
    page.on("requestfailed", (req) => {
      // Ignore favicon-style aborts; report anything the page actually depends on.
      const u = req.url();
      if (!u.startsWith("data:"))
        problems.push(`requestfailed: ${u} ${req.failure()?.errorText ?? ""}`);
    });

    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: cfg.theme }]);
    await page.setViewport({ width: cfg.width, height: cfg.height, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: "networkidle0", timeout: 20000 });

    // Let the replayed session arrive, then start playback to exercise the audio graph.
    await new Promise((r) => setTimeout(r, 1600));
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "Play",
      );
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 1200));

    const cspViolations = await page.evaluate(() => window.__csp ?? []);
    for (const v of cspViolations) problems.push(`csp: ${v}`);

    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    if (theme !== cfg.theme) problems.push(`theme: expected ${cfg.theme}, got ${theme}`);

    const shot = join(SCREENS, `sim-${cfg.theme}-${cfg.width}.png`);
    await page.screenshot({ path: shot });
    written.push(shot);

    const label = `${cfg.theme} ${cfg.width}x${cfg.height}`;
    if (problems.length > 0) {
      failures.push(`${label}: ${problems.join(" | ")}`);
      console.error(`ui-gates: FAIL ${label}`);
      for (const p of problems) console.error(`   ${p}`);
    } else {
      console.log(`ui-gates: ok   ${label}  -> ${shot}`);
    }
    await page.close();
  }

  await browser.close();
  host.wss.close();
  host.server.close();
  web.close();

  console.log("");
  console.log(
    "ui-gates: exercised the built UI against an in-process stub host (WebSocket replay + media).",
  );
  console.log(`ui-gates: wrote ${written.length} screenshots to ${SCREENS}`);
  for (const w of written) console.log(`   ${w}`);
  console.log(
    "ui-gates: the live episode server and host process are driven by their own build, not here.",
  );

  if (failures.length > 0) {
    console.error(`\nui-gates: ${failures.length} configuration(s) failed.`);
    process.exit(1);
  }
  console.log("\nui-gates: all configurations clean (zero console errors, zero CSP violations).");
  process.exit(0);
}

main().catch((err) => {
  console.error("ui-gates: fatal", err);
  process.exit(1);
});
