// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. One place that decides the actual ttl.

/**
 * Resolves the ttl a task will actually get, in milliseconds.
 *   null       -> unlimited (returned as null)
 *   undefined  -> the store default
 *   a number   -> floored, clamped to [0, max]
 * Receivers MAY override the requested ttl and this is where we do it.
 */
export function capTtl(
  requested: number | null | undefined,
  maxMs: number,
  defaultMs: number,
): number | null {
  if (requested === null) {
    return null;
  }
  if (requested === undefined || !Number.isFinite(requested)) {
    return defaultMs;
  }
  const floored = Math.floor(requested);
  if (floored < 0) {
    return 0;
  }
  return Math.min(floored, maxMs);
}
