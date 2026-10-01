// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. Opaque, scope-bound pagination cursors.

import { createHash } from "node:crypto";
import { InvalidCursorError } from "../errors.js";

interface CursorPayload {
  v: 1;
  s: string; // scope fingerprint, not the scope itself
  k: number; // ordering key: the row sequence to resume after
}

// A short, non-reversible fingerprint of the scope. It lets us reject a cursor
// minted for one principal and replayed under another, without putting the
// principal id into a value the client holds.
function fingerprint(scope: string): string {
  return createHash("sha256").update(scope, "utf8").digest("base64url").slice(0, 16);
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record["v"] === 1 && typeof record["s"] === "string" && typeof record["k"] === "number";
}

/** Encodes a resume key for a scope into an opaque base64url cursor. */
export function encodeCursor(scope: string, key: number): string {
  const payload: CursorPayload = { v: 1, s: fingerprint(scope), k: key };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decodes a cursor and returns its resume key. Throws InvalidCursorError on any
 * garbage and on a cursor whose scope fingerprint does not match this scope.
 */
export function decodeCursor(scope: string, cursor: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new InvalidCursorError();
  }
  if (!isCursorPayload(parsed) || parsed.s !== fingerprint(scope)) {
    throw new InvalidCursorError();
  }
  return parsed.k;
}
