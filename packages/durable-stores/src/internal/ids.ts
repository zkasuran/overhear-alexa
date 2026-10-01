// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. Unbiased base62 ids, self-contained.

import { randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A random base62 string of the given length, drawn with rejection sampling so
 * every character is uniform. 22 characters carry about 131 bits.
 */
export function randomBase62(length: number): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError("randomBase62: length must be a positive integer");
  }
  const limit = 256 - (256 % 62); // reject bytes at or above 248 to stay unbiased
  const out: string[] = [];
  while (out.length < length) {
    const buf = randomBytes(length - out.length + 8);
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const b = buf[i] ?? 0;
      if (b < limit) {
        out.push(BASE62[b % 62] ?? "0");
      }
    }
  }
  return out.join("");
}

/** A fresh task id. 128-bit class, base62, no separators to parse. */
export const newTaskId = (): string => randomBase62(22);
