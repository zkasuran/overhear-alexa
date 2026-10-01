#!/usr/bin/env node
// overhear-conformance <url> [--token-file F] [--token T] [--json out.json]
//                            [--token2 T | --token2-file F] [--timeout MS]
//
// Runs the MCP 2025-11-25 conformance matrix against any Streamable HTTP MCP URL over raw
// HTTP + JSON-RPC + manual SSE (no MCP SDK). Exit 0 only when every non-advisory row passes.
// --token2 supplies a second principal so the isolation rows (T-10, R-3) can run.

import { readFile, writeFile } from "node:fs/promises";
import type { CheckContext } from "./checks.js";
import { PROTOCOL_VERSION } from "./checks.js";
import { formatReport, runConformance } from "./runner.js";

type Args = {
  url?: string;
  token?: string;
  tokenFile?: string;
  token2?: string;
  token2File?: string;
  json?: string;
  timeoutMs: number;
  help: boolean;
};

const USAGE = [
  "usage: overhear-conformance <url> [options]",
  "  --token T            bearer token for the primary principal",
  "  --token-file F       read the primary token from a file (trimmed)",
  "  --token2 T           bearer token for a second principal (enables T-10, R-3)",
  "  --token2-file F      read the second token from a file (trimmed)",
  "  --json FILE          write the full report as JSON",
  "  --timeout MS         per-request timeout in milliseconds (default 15000)",
  "  -h, --help           show this help",
].join("\n");

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { timeoutMs: 15000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === undefined) continue;
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const take = (): string | undefined => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case "--token": {
        const v = take();
        if (v !== undefined) args.token = v;
        break;
      }
      case "--token-file": {
        const v = take();
        if (v !== undefined) args.tokenFile = v;
        break;
      }
      case "--token2": {
        const v = take();
        if (v !== undefined) args.token2 = v;
        break;
      }
      case "--token2-file": {
        const v = take();
        if (v !== undefined) args.token2File = v;
        break;
      }
      case "--json": {
        const v = take();
        if (v !== undefined) args.json = v;
        break;
      }
      case "--timeout": {
        const v = take();
        const n = v === undefined ? NaN : Number.parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) args.timeoutMs = n;
        break;
      }
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (!raw.startsWith("-") && args.url === undefined) args.url = raw;
        break;
    }
  }
  return args;
}

async function readToken(
  value: string | undefined,
  file: string | undefined,
): Promise<string | undefined> {
  if (value !== undefined) return value;
  if (file !== undefined) return (await readFile(file, "utf8")).trim();
  return undefined;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (args.url === undefined) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }
  const token = await readToken(args.token, args.tokenFile);
  const secondaryToken = await readToken(args.token2, args.token2File);
  const ctx: CheckContext = {
    url: args.url,
    token,
    secondaryToken,
    protocolVersion: PROTOCOL_VERSION,
    timeoutMs: args.timeoutMs,
  };
  const report = await runConformance(ctx);
  process.stdout.write(formatReport(report) + "\n");
  if (args.json !== undefined)
    await writeFile(args.json, JSON.stringify(report, null, 2) + "\n", "utf8");
  return report.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
