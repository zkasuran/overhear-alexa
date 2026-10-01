// Vite build config for the simulator UI. The one custom piece is a build-only plugin that generates a
// strict Content-Security-Policy and injects it as a meta tag. script-src is 'self' plus the sha256 of
// every inline script actually present in the built HTML (just the no-flash theme script), so no inline
// hash is hand-maintained. connect-src lists the exact hosts the UI talks to: the simulator host's
// WebSocket and media proxy, and the episode server. frame-ancestors is set in public/_headers, since a
// meta policy cannot carry it.

import { createHash } from "node:crypto";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const SIM_HTTP = "http://127.0.0.1:8788";
const SIM_WS = "ws://127.0.0.1:8788";
const SERVER_HTTP = "http://127.0.0.1:8787";

function cspPlugin(): Plugin {
  return {
    name: "overhear-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html: string): string {
        const hashes: string[] = [];
        const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
        for (let m = re.exec(html); m !== null; m = re.exec(html)) {
          const code = m[1] ?? "";
          hashes.push(`'sha256-${createHash("sha256").update(code, "utf8").digest("base64")}'`);
        }
        const csp = [
          "default-src 'none'",
          `script-src 'self' ${hashes.join(" ")}`.trim(),
          "style-src 'self'",
          "img-src 'self' data:",
          "font-src 'self' data:",
          `connect-src 'self' ${SIM_HTTP} ${SIM_WS} ${SERVER_HTTP}`,
          "base-uri 'none'",
          "form-action 'none'",
          "object-src 'none'",
        ].join("; ");
        const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
        return html.replace("<head>", `<head>\n    ${meta}`);
      },
    },
  };
}

export default defineConfig({
  plugins: [cspPlugin()],
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
