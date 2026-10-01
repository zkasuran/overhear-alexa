// The only module in the simulator host that reads process.env. It builds a validated Config once at
// boot; everything else receives config as an argument. The bearer token is read from a file (never an
// argv or an env value, so it cannot leak into a process listing or a log) and is held here only to
// hand to the MCP transport.

import { readFileSync } from "node:fs";

export type Config = {
  /** The MCP endpoint of the episode server, for example http://127.0.0.1:8787/mcp. */
  serverUrl: string;
  /** The origin of that server, derived from serverUrl, used to resolve /media URLs for the proxy. */
  serverOrigin: string;
  /** The bearer token for the server. Secret: never logged, never sent to the browser. */
  token: string;
  /** Where the host binds its WebSocket and media proxy. */
  host: string;
  port: number;
  /** Allowed browser origins for the media proxy CORS header. Empty means reflect any origin. */
  webOrigins: readonly string[];
};

function originOf(url: string): string {
  return new URL(url).origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const serverUrl = env.SIM_SERVER_URL ?? "http://127.0.0.1:8787/mcp";
  const tokenFile = env.SIM_TOKEN_FILE ?? "fixtures/test-token";
  const token = readFileSync(tokenFile, "utf8").trim();
  if (token.length === 0) {
    throw new Error(`token file ${tokenFile} is empty`);
  }
  const webOrigins = (env.SIM_WEB_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    serverUrl,
    serverOrigin: originOf(serverUrl),
    token,
    host: env.SIM_HOST_HOST ?? "127.0.0.1",
    port: Number(env.SIM_HOST_PORT ?? "8788"),
    webOrigins,
  };
}

/** Startup banner lines. The token is never included. */
export function bannerLines(c: Config): string[] {
  return [
    `simulator host  ws=ws://${c.host}:${c.port}/ws  media=http://${c.host}:${c.port}/media`,
    `server=${c.serverUrl}  origin=${c.serverOrigin}`,
    `webOrigins=[${c.webOrigins.join(",")}]${c.webOrigins.length === 0 ? " (reflect any)" : ""}`,
  ];
}
