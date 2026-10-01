// Static bearer-token auth. The token file holds one `principal:sha256(token)` line per principal, so
// the plaintext token never sits on disk. A caller presents `Authorization: Bearer <token>`; we hash
// it and compare against the stored digests in constant time, then return the principal that owns it.
// Tokens never reach a log or argv (see SECURITY.md): only the derived principal is ever logged.

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Logger } from "./contracts.js";

/** One parsed token line: the principal and the raw 32-byte SHA-256 digest of its token. */
export interface TokenEntry {
  principal: string;
  digest: Buffer;
}

export type TokenTable = readonly TokenEntry[];

export interface AuthVerifier {
  /** Returns the owning principal for a valid `Authorization` header. Null for a missing or wrong one. */
  verifyBearer(header: string | null | undefined): string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;
const BEARER = /^Bearer[ \t]+(\S.*?)[ \t]*$/i;

/**
 * Parse the token-file text into a table. Blank lines and `#` comments are skipped. A line is
 * `principal:sha256hex`; the principal is everything before the first colon. Malformed lines (no
 * colon, empty principal, digest that is not 64 hex chars) are skipped so one bad line cannot abort
 * boot. The loader rejects a file that ends up with zero valid entries.
 */
export function parseTokenTable(text: string): TokenEntry[] {
  const out: TokenEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const principal = line.slice(0, colon).trim();
    const hex = line.slice(colon + 1).trim();
    if (principal === "" || !SHA256_HEX.test(hex)) continue;
    out.push({ principal, digest: Buffer.from(hex, "hex") });
  }
  return out;
}

/** True when the file permission bits deny all group and world access (mode 600 or stricter). */
export function tokenFileModeIsSecure(mode: number): boolean {
  return (mode & 0o077) === 0;
}

export interface LoadTokensOptions {
  /** Permit a group or world readable file. Only for local dev with a public fixture token. */
  allowInsecurePermissions?: boolean;
  log?: Logger;
}

/**
 * Load and validate the token file. Throws when the file is missing, when it is group or world
 * accessible outside the dev allowance or when it holds no usable entries. A misconfigured
 * deployment then fails loudly at boot rather than serving every request unauthenticated.
 */
export function loadTokenFile(path: string, options: LoadTokensOptions = {}): TokenTable {
  const stat = statSync(path);
  const mode = stat.mode & 0o777;
  if (!tokenFileModeIsSecure(mode)) {
    if (options.allowInsecurePermissions !== true) {
      throw new Error(
        `token file ${path} is group or world accessible (mode ${mode.toString(8)}); run chmod 600 on it`,
      );
    }
    options.log?.warn("token file is group or world readable, permitted only in local dev", {
      path,
      mode: mode.toString(8),
    });
  }
  const table = parseTokenTable(readFileSync(path, "utf8"));
  if (table.length === 0) {
    throw new Error(`token file ${path} has no valid principal:sha256 entries`);
  }
  return table;
}

/**
 * Verify a bearer header against the table. Returns the matching principal or null. The SHA-256 of the
 * presented token is compared to every stored digest with a constant-time compare. The scan does not
 * stop early, so a caller cannot learn a token from the response time.
 */
export function verifyBearer(table: TokenTable, header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = BEARER.exec(header);
  if (match === null) return null;
  const token = match[1];
  if (token === undefined || token.length === 0) return null;
  const presented = createHash("sha256").update(token).digest();
  let principal: string | null = null;
  for (const entry of table) {
    if (entry.digest.length === presented.length && timingSafeEqual(entry.digest, presented)) {
      principal = entry.principal;
    }
  }
  return principal;
}

/** Bind a table into a verifier so callers hold one object and never see the digests. */
export function makeAuthVerifier(table: TokenTable): AuthVerifier {
  return { verifyBearer: (header) => verifyBearer(table, header) };
}
