// CSPRNG id generators. All ids are URL-safe base62. Session and task ids are 128-bit.
// Ids are identity; never derive meaning from them. No modulo bias: rejection sampling.

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RADIX = ALPHABET.length; // 62

/** `len` cryptographically random base62 characters, unbiased. */
export function randomBase62(len: number): string {
  if (len <= 0) throw new Error("randomBase62: len must be positive");
  // 256 % 62 === 8, so bytes 248..255 would bias toward 0..7. Reject them.
  const cutoff = 256 - (256 % RADIX); // 248
  let out = "";
  while (out.length < len) {
    const buf = randomBytes(len - out.length + 8);
    for (let i = 0; i < buf.length && out.length < len; i++) {
      const b = buf[i] as number;
      if (b < cutoff) out += ALPHABET[b % RADIX];
    }
  }
  return out;
}

export const newEpisodeId = (): string => `ep_${randomBase62(22)}`;
export const newPartId = (): string => `pt_${randomBase62(16)}`;
export const newLineId = (): string => `ln_${randomBase62(12)}`;

/** 128-bit, visible ASCII, used for MCP session ids and task ids. */
export const newSessionId = (): string => randomBase62(22);
export const newTaskId = (): string => randomBase62(22);

/** Unguessable local-media path token. */
export function newMediaToken(bytes: number): string {
  if (bytes <= 0) throw new Error("newMediaToken: bytes must be positive");
  // ceil(bytes * 8 / log2(62)) base62 chars carry at least `bytes` bytes of entropy.
  const chars = Math.ceil((bytes * 8) / Math.log2(RADIX));
  return randomBase62(chars);
}
