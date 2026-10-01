// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. JSON helpers that keep types honest.

import { PayloadTooLargeError } from "../errors.js";

/** Parses JSON into unknown, never into any. Callers narrow at the boundary. */
export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * Serializes a value to JSON and refuses it past a byte ceiling, so one hostile
 * payload cannot bloat the store. Returns the JSON text when within the limit.
 */
export function serializeWithinLimit(value: unknown, maxBytes: number, label: string): string {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new PayloadTooLargeError(label, bytes, maxBytes);
  }
  return text;
}
